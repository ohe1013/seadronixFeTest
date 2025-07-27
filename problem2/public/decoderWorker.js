// --- Worker Globals ---
let socket;
let videoDecoder, audioDecoder;
let v_configured = false,
  a_configured = false;
let annexbBuffer = new Uint8Array();
let sps, pps;
let firstAudioTimestamp = 0;
let savedUrl, savedBaseURL, savedAudioConfig;
let mode = null;
let socketOpen = false;
let videoMetadataQueue = [];
let sendQueue = [];
self.onmessage = (ev) => {
  const m = ev.data;
  // console.log(`Worker: Received message type: ${m.type}`);
  if (m.type === "start-upload") {
    firstAudioTimestamp = 0;
    savedBaseURL = m.baseURL;
    savedAudioConfig = m.audioConfig;
    mode = "upload";
    connect();
  } else if (m.type === "file-chunk") {
    const data = m.chunk;
    if (socketOpen && socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    } else {
      // console.log(
      //   `Worker: Socket not open, queuing file chunk, size: ${data.byteLength}`
      // );
      sendQueue.push(data);
    }
  } else if (m.type === "file-end") {
    const eof = JSON.stringify({ type: "eof" });
    if (socketOpen) {
      socket.send(eof);
      // console.log("Worker: Sent EOF message to socket.");
    } else {
      // console.log("Worker: Socket not open, queuing EOF message.");
      sendQueue.push(eof);
    }
  } else if (m.type === "start-url") {
    mode = "url";
    savedUrl = m.url;
    savedBaseURL = m.baseURL;
    savedAudioConfig = m.audioConfig;
    firstAudioTimestamp = 0;
    connect();
  } else if (m.type === "seek") {
    // console.log(`Worker: Received seek command to time: ${m.time}`);
    socket.send(JSON.stringify({ type: "seek", time: m.time }));
    firstAudioTimestamp = 0;
    videoMetadataQueue = [];
    // console.log("Worker: Resetting state due to seek command.");
  }
};
function connect() {
  // console.log(`Worker: Attempting to connect WebSocket (mode: ${mode})`);
  resetState();
  socket?.close();
  socket = new WebSocket(
    mode === "upload"
      ? `ws://${self.location.host}/stream?mode=upload`
      : `${savedBaseURL}?src=${encodeURIComponent(savedUrl)}`
  );
  socket.binaryType = "arraybuffer";
  socket.onopen = () => {
    socketOpen = true;
    // console.log("Worker: WebSocket connection opened.");
    for (const msg of sendQueue) {
      socket.send(msg);
    }
    sendQueue = [];
    self.postMessage({ type: "status", message: "WebSocket Connected" });
  };
  socket.onclose = (event) => {
    socketOpen = false;
    // console.log(
    //   `Worker: WebSocket connection closed. Code: ${event.code}, Reason: ${event.reason}`
    // );
    self.postMessage({ type: "status", message: "WebSocket Closed" });
  };
  socket.onerror = (e) => {
    console.error("Worker: WebSocket error:", e);
    self.postMessage({
      type: "error",
      message: `WebSocket error: ${e.message || e}`,
    });
  };
  socket.onmessage = handleSocketMessage;
}
function resetState() {
  // console.log("Worker: Resetting decoder state...");
  if (videoDecoder) {
    videoDecoder.close();
    videoDecoder = undefined;
    v_configured = false;
    // console.log("Worker: VideoDecoder closed.");
  }
  if (audioDecoder) {
    audioDecoder.close();
    a_configured = false;
    audioDecoder = undefined;
    // console.log("Worker: AudioDecoder closed.");
  }
  annexbBuffer = new Uint8Array();
  sps = undefined;
  pps = undefined;
  videoMetadataQueue = [];
  // console.log("Worker: Decoder state reset complete.");
}
async function handleSocketMessage(ev) {
  if (typeof ev.data === "string") {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "reset") {
        // console.log("Worker: Server requested reset. Re-initializing.");
        self.postMessage({
          type: "status",
          message: "Server requested reset. Re-initializing.",
        });
        resetState();
      } else {
        // console.log(
        //   `Worker: Received JSON message from server: ${JSON.stringify(msg)}`
        // );
      }
    } catch (e) {
      console.warn(
        `Worker: Received non-JSON string message or JSON parsing error: ${e.message}, data: ${ev.data}`
      );
    }
    return;
  }
  const packet = new Uint8Array(ev.data);
  const type = packet[0];
  const serverTs = Number(
    new DataView(packet.buffer, 1, 8).getBigUint64(0, false)
  );
  const body = packet.subarray(9);
  const recvMainTime = Date.now();
  const recvWorkerTime = performance.now();
  const networkLatency = performance.timeOrigin + recvWorkerTime - serverTs;
  if (type === 1) {
    handleVideoPacket(body, serverTs, networkLatency, recvMainTime);
  } else if (type === 2) {
    handleAudioPacket(body, serverTs);
  } else {
    console.warn(
      `Worker: Received unknown packet type: ${type}, size: ${body.byteLength}`
    );
  }
}
async function handleVideoPacket(body, serverTs, networkLatency, recvMainTime) {
  const combined = new Uint8Array(annexbBuffer.byteLength + body.byteLength);
  combined.set(annexbBuffer, 0);
  combined.set(body, annexbBuffer.byteLength);
  annexbBuffer = combined;
  const nalUnits = extractNALUnits(annexbBuffer);
  annexbBuffer = nalUnits.pop() || new Uint8Array();
  if (!v_configured) {
    let foundSPS = false,
      foundPPS = false;
    for (const nal of nalUnits) {
      const nt = nal[0] & 0x1f;
      if (nt === 7) {
        sps = nal;
        foundSPS = true;
        // console.log(`Worker: Found SPS NAL (type 7), size: ${nal.byteLength}`);
      } else if (nt === 8) {
        pps = nal;
        foundPPS = true;
        // console.log(`Worker: Found PPS NAL (type 8), size: ${nal.byteLength}`);
      }
    }
    if (sps && pps) {
      // console.log(
      //   `Worker: SPS and PPS found. Initializing video decoder with SPS len: ${sps.byteLength}, PPS len: ${pps.byteLength}`
      // );
      await initVideoDecoder(createConfig(sps, pps), sps);
    } else if (foundSPS || foundPPS) {
      // console.log(
      //   "Worker: Waiting for both SPS and PPS to configure video decoder."
      // );
    }
  }
  let frameNals = [];
  function flushFrame() {
    if (
      !videoDecoder ||
      !v_configured ||
      videoDecoder.state !== "configured" ||
      frameNals.length === 0
    ) {
      // console.log(
      //   `Worker: Skipping flushFrame - decoder not ready (${
      //     !videoDecoder
      //       ? "No Decoder"
      //       : videoDecoder.state !== "configured"
      //       ? "Not Configured"
      //       : "Configured"
      //   }) or no NALs (${frameNals.length}).`
      // );
      return;
    }
    videoMetadataQueue.push({ serverTs, networkLatency, recvMainTime });
    let total = frameNals.reduce((sum, n) => sum + 4 + n.byteLength, 0);
    const frameData = new Uint8Array(total);
    let off = 0;
    for (const nal of frameNals) {
      frameData.set([0, 0, 0, 1], off);
      off += 4;
      frameData.set(nal, off);
      off += nal.byteLength;
    }
    const isKey = frameNals.some((n) => (n[0] & 0x1f) === 5);
    // console.log(
    //   `Worker: Decoding video chunk (type: ${isKey ? "key" : "delta"}), NALs: ${
    //     frameNals.length
    //   }, total size: ${frameData.byteLength}, timestamp: ${serverTs * 1000}`
    // );
    videoDecoder.decode(
      new EncodedVideoChunk({
        type: isKey ? "key" : "delta",
        timestamp: serverTs * 1000,
        data: frameData,
      })
    );
    frameNals = [];
  }
  if (v_configured && videoDecoder.state === "configured") {
    for (const nal of nalUnits) {
      const nt = nal[0] & 0x1f;
      if (nt === 9) {
        if (frameNals.length > 0) {
          flushFrame();
        }
        continue;
      }
      if (nt === 1 || nt === 5 || nt === 7 || nt === 8) {
        frameNals.push(nal);
      } else {
        console.log(`Worker: Skipping NAL unit type ${nt} for frame assembly.`);
      }
    }
    if (frameNals.length > 0) {
      flushFrame();
    }
  } else {
    console.log(
      `Worker: Video decoder not yet configured (v_configured: ${v_configured}, state: ${videoDecoder?.state}). Holding video packets.`
    );
  }
}
function handleAudioPacket(body, serverTs) {
  if (!a_configured) {
    console.log(
      "Worker: Audio decoder not configured yet. Attempting configuration."
    );
    initAudioDecoder(savedAudioConfig);
  }
  if (audioDecoder.state === "configured") {
    if (firstAudioTimestamp === 0) {
      firstAudioTimestamp = serverTs;
      console.log(
        `Worker: First audio timestamp set to: ${firstAudioTimestamp}`
      );
    }
    audioDecoder.decode(
      new EncodedAudioChunk({
        type: "key",
        timestamp: serverTs * 1000,
        data: body,
      })
    );
  } else {
    console.log(
      `Worker: Audio decoder not configured (state: ${audioDecoder?.state}). Holding audio packets.`
    );
  }
}
async function initVideoDecoder(config, spsNal) {
  const p = spsNal[1].toString(16).padStart(2, "0"),
    c = spsNal[2].toString(16).padStart(2, "0"),
    l = spsNal[3].toString(16).padStart(2, "0"),
    codecId = `avc1.${p}${c}${l}`;
  // console.log(
  //   "Worker: Attempting to configure video decoder with codec:",
  //   codecId
  // );
  videoDecoder = new VideoDecoder({
    output: (frame) => {
      // console.log(
      //   "Worker: ✅ Video frame successfully decoded! Timestamp:",
      //   frame.timestamp,
      //   "Duration:",
      //   frame.duration,
      //   "Format:",
      //   frame.format,
      //   "Size:",
      //   `${frame.codedWidth}x${frame.codedHeight}`
      // );
      const metadata = videoMetadataQueue.shift();
      if (!metadata) {
        console.warn("Worker: Decoded frame is missing metadata, skipping.");
        frame.close();
        return;
      }
      self.postMessage({ type: "decodedVideoFrame", frame, stats: metadata }, [
        frame,
      ]);
    },
    error: (e) => {
      console.error("Worker: ❌ VideoDecoder error:", e);
      console.error("Worker: VideoDecoder state on error:", videoDecoder.state);
      console.error(
        "Worker: VideoDecoder config (attempted) on error:",
        codecId
      );
      self.postMessage({
        type: "error",
        message: `Video decoding error: ${e.message}`,
      });
      videoDecoder?.close();
      videoDecoder = undefined;
      v_configured = false;
    },
  });
  try {
    videoDecoder.configure({ codec: codecId, optimizeForLatency: true });
    v_configured = true;
    self.postMessage({
      type: "status",
      message: `Video decoder configured: ${codecId}`,
    });
    console.log("Worker: Video decoder configuration completed.");
  } catch (error) {
    console.error("Worker: ❌ VideoDecoder configuration failed:", error);
    self.postMessage({
      type: "error",
      message: `Video decoder configuration failed: ${error.message}`,
    });
    if (videoDecoder && videoDecoder.state !== "closed") {
      videoDecoder.close();
    }
    videoDecoder = undefined;
    v_configured = false;
  }
}
function initAudioDecoder(config) {
  console.log(
    `Worker: Attempting to configure audio decoder with codec: ${config.codec}`
  );
  audioDecoder = new AudioDecoder({
    output: (audioData) => {
      if (firstAudioTimestamp === 0) {
        firstAudioTimestamp = audioData.timestamp;
        console.log(
          `Worker: First audio timestamp set to: ${firstAudioTimestamp}`
        );
      }
      const offsetSec = (audioData.timestamp - firstAudioTimestamp) / 1_000_000;
      self.postMessage({ type: "decodedAudioChunk", audioData, offsetSec }, [
        audioData,
      ]);
    },
    error: (e) => {
      console.error("Worker: ❌ AudioDecoder error:", e);
      self.postMessage({
        type: "error",
        message: `Audio decoding error: ${e.message}`,
      });
      audioDecoder?.close();
      audioDecoder = undefined;
      a_configured = false;
    },
  });
  try {
    audioDecoder.configure(config);
    a_configured = true;
    self.postMessage({
      type: "status",
      message: `Audio decoder configured: ${config.codec}`,
    });
    console.log(
      `Worker: Audio decoder configuration completed with codec: ${config.codec}`
    );
  } catch (error) {
    console.error("Worker: ❌ AudioDecoder configuration failed:", error);
    self.postMessage({
      type: "error",
      message: `Audio decoder configuration failed: ${error.message}`,
    });
    audioDecoder?.close();
    audioDecoder = undefined;
    a_configured = false;
  }
}
function createConfig(sps, pps) {
  const spsLen = sps.byteLength,
    ppsLen = pps.byteLength,
    desc = new Uint8Array(7 + 2 + spsLen + 1 + 2 + ppsLen);
  let o = 0;
  desc[o++] = 1;
  desc[o++] = sps[1];
  desc[o++] = sps[2];
  desc[o++] = sps[3];
  desc[o++] = 0xff;
  desc[o++] = 0xe1;
  desc[o++] = (spsLen >> 8) & 0xff;
  desc[o++] = spsLen & 0xff;
  desc.set(sps, o);
  o += spsLen;
  desc[o++] = 1;
  desc[o++] = (ppsLen >> 8) & 0xff;
  desc[o++] = ppsLen & 0xff;
  desc.set(pps, o);
  return desc;
}
function extractNALUnits(buf) {
  const units = [];
  let start = 0,
    i = 0;
  while (i + 3 < buf.length) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      if (i > start) units.push(buf.subarray(start, i));
      start = i + 3;
      i += 3;
    } else if (
      buf[i] === 0 &&
      buf[i + 1] === 0 &&
      buf[i + 2] === 0 &&
      buf[i + 3] === 1
    ) {
      if (i > start) units.push(buf.subarray(start, i));
      start = i + 4;
      i += 4;
    } else {
      i++;
    }
  }
  if (start < buf.length) units.push(buf.subarray(start));
  return units;
}
