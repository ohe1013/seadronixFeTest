import http from "http";
import fs from "fs";
import path, { dirname, join } from "path";
import { WebSocketServer } from "ws";
import { spawn } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, "public");
const PORT = 3000;

const ffmpegBin = join(
  __dirname,
  "tools",
  "ffmpeg",
  "bin",
  process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
);
const ffprobeBin = join(
  __dirname,
  "tools",
  "ffmpeg",
  "bin",
  process.platform === "win32" ? "ffprobe.exe" : "ffprobe"
);

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".mp4": "video/mp4",
  ".json": "application/json",
};

const WEB_SUPPORTED_VIDEO_CODECS = ["h264", "avc1", "vp8", "vp9", "av1"];
const WEB_SUPPORTED_AUDIO_CODECS = ["aac", "mp4a", "opus", "vorbis", "mp3"];

const server = http.createServer((req, res) => {
  let urlPath = req.url.split("?")[0] || "/";
  if (urlPath === "/") urlPath = "/index.html";

  const fp = join(PUBLIC_DIR, urlPath);
  if (!fs.existsSync(fp)) {
    res.writeHead(404).end("404 Not Found");
    return;
  }

  const ext = path.extname(fp).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
  });
  fs.createReadStream(fp).pipe(res);
});

const wss = new WebSocketServer({ server, path: "/stream" });

async function getMediaInfo(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-show_streams",
      "-print_format",
      "json",
      filePath,
    ];
    const ffprobe = spawn(ffprobeBin, args);
    let stdout = "",
      stderr = "";
    ffprobe.stdout.on("data", (d) => (stdout += d));
    ffprobe.stderr.on("data", (d) => (stderr += d));
    ffprobe.on("close", (code) => {
      if (code !== 0)
        return reject(new Error(`FFprobe exited with code ${code}: ${stderr}`));
      try {
        const info = JSON.parse(stdout),
          streams = info.streams || [],
          videoStream = streams.find((s) => s.codec_type === "video"),
          audioStream = streams.find((s) => s.codec_type === "audio");
        resolve({ video: videoStream, audio: audioStream });
      } catch (e) {
        reject(
          new Error(
            `FFprobe JSON parsing error: ${e.message}\nOutput: ${stdout}`
          )
        );
      }
    });
    ffprobe.on("error", (err) =>
      reject(new Error(`Failed to start FFprobe: ${err.message}`))
    );
  });
}

// ✨ REFINED probeUploadStream function (ffprobe 기반으로 롤백 + movflags 및 오디오 코덱 로직 반영)
async function probeUploadStream(ws) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v",
      "error",
      "-show_streams",
      "-print_format",
      "json",
      // ✨ movflags 옵션 추가 (입력 스트림에 대한 힌트 제공)
      "-f",
      "mp4", // 입력 포맷을 mp4로 명시 (업로드하는 파일이 대부분 mp4라고 가정)
      "-movflags",
      "empty_moov+frag_keyframe", // 불완전한 파일, 스트리밍 파일에 대한 안정성 향상
      "-analyzeduration",
      "5M", // 5MB 분석
      "-probesize",
      "5M", // 5MB 프로브 (이전 제안과 동일하게 유지)
      "-i",
      "pipe:0", // 표준 입력 파이프를 입력으로 사용
    ];

    console.log(
      "Attempting to spawn ffprobe from:",
      ffprobeBin,
      "with args:",
      args.join(" ")
    );

    let probe;
    try {
      probe = spawn(ffprobeBin, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      console.log("ffprobe spawned successfully. Checking stdio pipes...");

      if (!probe.stdin || !probe.stdout || !probe.stderr) {
        console.error(
          "CRITICAL ERROR: One or more ffprobe stdio pipes are null after spawn!"
        );
        return reject(new Error("ffprobe stdio 파이프를 사용할 수 없습니다."));
      }
      console.log("ffprobe stdio pipes confirmed to be valid.");
    } catch (spawnError) {
      console.error(
        `ERROR: ffprobe 프로세스 시작 중 동기적 오류 발생: ${spawnError.message}`
      );
      return reject(
        new Error(
          `ffprobe 시작 실패: ${spawnError.message}. 경로 및 권한 확인.`
        )
      );
    }

    let stdout = "";
    let stderrOutput = "";
    const initialChunks = []; // ✨ 이 배열에 초기 청크들을 저장
    let totalBytesReceived = 0;
    const MAX_PROBE_BYTES = 5 * 1024 * 1024; // 최대 5MB까지만 프로빙

    let resolvedOrRejected = false;
    let stdinEpipeOccurred = false;

    const cleanup = () => {
      clearTimeout(probeTimeout);
      ws.off("message", onMessage); // WebSocket 메시지 리스너 제거

      if (probe.stdin && !probe.stdin.writableEnded) {
        try {
          console.log("Cleanup: Ending ffprobe stdin.");
          probe.stdin.end();
        } catch (e) {
          console.error("FFprobe stdin 종료 중 오류 (cleanup):", e.message);
        }
      }
      if (probe && probe.exitCode === null && probe.signalCode === null) {
        try {
          console.log("Cleanup: Terminating ffprobe process.");
          probe.kill("SIGINT");
        } catch (e) {
          console.error(
            "FFprobe 프로세스 강제 종료 중 오류 (cleanup):",
            e.message
          );
        }
      }
    };

    probe.on("error", (err) => {
      console.error(
        `ERROR: ffprobe 프로세스 실행 실패 또는 즉각적인 오류 발생: ${err.message}`
      );
      if (resolvedOrRejected) return;
      resolvedOrRejected = true;
      cleanup();
      reject(
        new Error(
          `ffprobe 실행 실패: ${err.message}. ${
            stderrOutput ? `Stderr: ${stderrOutput}` : ""
          }`
        )
      );
    });

    probe.stdin.on("error", (err) => {
      const isEPIPEorEOFMessage =
        (err.code === "EPIPE" && err.syscall === "write") ||
        err.message.includes("EOF");

      if (isEPIPEorEOFMessage) {
        console.warn(
          `WARNING: ffprobe stdin 파이프 'write EOF' 관련 오류 발생. (ffprobe 종료 코드 대기): ${err.message}`
        );
        stdinEpipeOccurred = true;
        return; // 이 오류는 무시하고 성공적인 ffprobe 종료를 기다립니다.
      }

      console.error(
        `ERROR: ffprobe stdin 파이프 예상치 못한 치명적인 오류 발생: ${err.message}`
      );
      if (resolvedOrRejected) return;
      resolvedOrRejected = true;
      cleanup();
      reject(
        new Error(
          `ffprobe stdin 파이프 예상치 못한 치명적인 오류: ${err.message}. ${
            stderrOutput ? `Stderr: ${stderrOutput}` : ""
          }`
        )
      );
    });

    probe.stdout.on("error", (err) => {
      console.error(`ERROR: ffprobe stdout 파이프 오류 발생: ${err.message}`);
      if (resolvedOrRejected) return;
      resolvedOrRejected = true;
      cleanup();
      reject(
        new Error(
          `ffprobe stdout 파이프 오류: ${err.message}. ${
            stderrOutput ? `Stderr: ${stderrOutput}` : ""
          }`
        )
      );
    });

    probe.stderr.on("error", (err) => {
      console.error(`ERROR: ffprobe stderr 파이프 오류 발생: ${err.message}`);
      if (resolvedOrRejected) return;
      resolvedOrRejected = true;
      cleanup();
      reject(
        new Error(
          `ffprobe stderr 파이프 오류: ${err.message}. ${
            stderrOutput ? `Stderr: ${stderrOutput}` : ""
          }`
        )
      );
    });

    const onMessage = (chunk) => {
      if (totalBytesReceived === 0) {
        console.log(
          `First WebSocket chunk received at: ${new Date().toISOString()}`
        );
      }
      if (Buffer.isBuffer(chunk) || chunk instanceof ArrayBuffer) {
        if (probe.stdin && !probe.stdin.writableEnded) {
          initialChunks.push(chunk); // 모든 청크를 일단 저장
          probe.stdin.write(chunk);
          totalBytesReceived += chunk.byteLength;
          // console.log(`FFprobe stdin에 청크 작성 중... (총 ${totalBytesReceived} 바이트)`);

          if (totalBytesReceived >= MAX_PROBE_BYTES) {
            console.log(
              `FFprobe: 최대 프로브 바이트(${
                MAX_PROBE_BYTES / (1024 * 1024)
              }MB)에 도달했습니다. stdin 종료 시도.`
            );
            if (!probe.stdin.writableEnded) {
              probe.stdin.end(); // 일정량 도달하면 stdin 종료
            }
          }
        } else {
          console.warn(
            "FFprobe stdin이 쓰기 불가능한 상태이거나 존재하지 않아 청크를 버립니다."
          );
          // stdin이 닫혔다면, 더 이상 할 일이 없으므로 return.
          return;
        }
      } else {
        try {
          const msg = JSON.parse(chunk.toString());
          if (msg.type === "eof") {
            console.log("FFprobe: 클라이언트로부터 EOF 수신. stdin 종료 시도.");
            if (probe.stdin && !probe.stdin.writableEnded) {
              probe.stdin.end(); // EOF 메시지를 받으면 stdin 종료
            }
          }
        } catch (e) {
          // 비-JSON 또는 파싱 오류는 무시
        }
      }
    };

    probe.stdout.on("data", (data) => {
      console.log(
        `FFprobe stdout에서 데이터 수신 중... (크기: ${data.byteLength})`
      );
      stdout += data.toString();
    });
    probe.stderr.on("data", (d) => {
      const str = d.toString();
      stderrOutput += str;
      console.error(`FFprobe stderr: ${str}`);
    });

    probe.on("close", (code) => {
      console.log(
        `FFprobe (업로드용) 프로세스가 코드 ${code}로 종료되었습니다.`
      );

      if (resolvedOrRejected) return;
      resolvedOrRejected = true;
      cleanup();

      if (code === 0) {
        if (stdinEpipeOccurred) {
          console.warn(
            "FFprobe가 성공적으로 종료되었으므로, 이전의 'write EOF' 관련 오류는 무시합니다."
          );
        }
        try {
          // stdout에 누적된 전체 데이터를 파싱합니다.
          const mediaInfo = JSON.parse(stdout);
          console.log(
            "✅ FFprobe 미디어 정보 파싱 성공:",
            JSON.stringify(mediaInfo, null, 2)
          );
          // ✨ 여기를 수정: mediaInfo와 함께 initialChunks도 resolve에 포함하여 반환
          resolve({ streams: mediaInfo.streams, initialChunks: initialChunks });
        } catch (jsonErr) {
          console.error("❌ FFprobe stdout JSON 파싱 오류:", jsonErr.message);
          console.error("FFprobe raw stdout:", stdout); // 파싱 실패 시 원본 데이터 출력
          reject(
            new Error(
              `미디어 정보 파싱 실패: ${jsonErr.message}. Raw: ${stdout}`
            )
          );
        }
      } else {
        // FFprobe가 오류 코드로 종료되었다면 reject
        reject(
          new Error(
            `ffprobe 업로드 스트림 프로브 실패. 코드: ${code}. Stderr: ${stderrOutput}`
          )
        );
      }
    });

    ws.on("message", onMessage);
    console.log(
      `WebSocket 'message' listener attached at: ${new Date().toISOString()}`
    );

    const probeTimeout = setTimeout(() => {
      if (resolvedOrRejected) return;
      console.warn(
        "FFprobe: 데이터 수신 없거나 분석 지연으로 프로빙 타임아웃."
      );
      resolvedOrRejected = true;
      cleanup();
      reject(new Error("ffprobe 프로빙 타임아웃."));
    }, 50000); // 15초 유지

    ws.once("close", () => {
      if (resolvedOrRejected) return;
      console.log(
        "FFprobe: 프로빙 중 WebSocket 연결 종료, 프로세스 강제 종료."
      );
      resolvedOrRejected = true;
      cleanup();
      reject(new Error("미디어 프로빙 중 WebSocket 연결이 닫혔습니다."));
    });
  });
}

// getMediaCodecInfo is fine
async function getMediaCodecInfo(filePath) {
  const info = await getMediaInfo(filePath);
  let videoCodec = null,
    audioCodec = null,
    videoProfile = null,
    audioSampleRate = null,
    audioChannels = null;

  if (info.video) {
    videoCodec = info.video.codec_name;
    videoProfile = info.video.profile;
  }
  if (info.audio) {
    audioCodec = info.audio.codec_name;
    // FFprobe는 'sample_rate' 필드를 반환합니다. 이전 오타 'sample_2_rate' 수정
    audioSampleRate = info.audio.sample_rate
      ? parseInt(info.audio.sample_rate, 10)
      : null;
    audioChannels = info.audio.channels;
  }

  return {
    video: { codec: videoCodec, profile: videoProfile },
    audio: {
      codec: audioCodec,
      sampleRate: audioSampleRate,
      channels: audioChannels,
    },
  };
}

wss.on("connection", async (ws, req) => {
  const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
  const mode = params.get("mode");
  const src = params.get("src");

  let ffVideo, ffAudio;
  let currentSeek = 0;
  let mediaCodecs = {
    video: { codec: null, profile: null },
    audio: { codec: null, sampleRate: null, channels: null },
  };
  let initialUploadChunks = []; // Store initial chunks consumed by FFprobe

  try {
    if (mode === "upload") {
      console.log("Upload mode: Detecting codec info from stream.");
      const probeResult = await probeUploadStream(ws);
      const streams = probeResult.streams;
      initialUploadChunks = probeResult.initialChunks;

      const videoStream = streams.find((s) => s.codec_type === "video");
      const audioStream = streams.find((s) => s.codec_type === "audio");

      if (videoStream) {
        mediaCodecs.video.codec = videoStream.codec_name;
        mediaCodecs.video.profile = videoStream.profile;
      }
      if (audioStream) {
        mediaCodecs.audio.codec = audioStream.codec_name;
        // FFprobe는 'sample_rate' 필드를 반환합니다. 이전 오타 'sample_2_rate' 수정
        mediaCodecs.audio.sampleRate = audioStream.sample_rate
          ? parseInt(audioStream.sample_rate, 10)
          : null;
        mediaCodecs.audio.channels = audioStream.channels;
      }

      console.log(`Detected upload codecs:`);
      console.log(
        ` Video: ${mediaCodecs.video.codec} (Profile: ${mediaCodecs.video.profile})`
      );
      console.log(
        ` Audio: ${mediaCodecs.audio.codec} (Sample Rate: ${mediaCodecs.audio.sampleRate}, Channels: ${mediaCodecs.audio.channels})`
      );

      // Send audio config to client (if audio stream detected)
      if (mediaCodecs.audio.codec) {
        let audioConfig = {
          codec: mediaCodecs.audio.codec,
          sampleRate: mediaCodecs.audio.sampleRate || 48000,
          numberOfChannels: mediaCodecs.audio.channels || 2,
        };
        // AAC-LC 프로파일 명시
        if (
          audioConfig.codec.toLowerCase() === "aac" ||
          audioConfig.codec.toLowerCase() === "mp4a"
        ) {
          audioConfig.codec = `mp4a.40.2`;
        }
        ws.send(JSON.stringify({ type: "audio-config", config: audioConfig }));
      }
    } else if (src) {
      mediaCodecs = await getMediaCodecInfo(src);
      console.log(`Detected codecs for ${src}:`);
      console.log(
        ` Video: ${mediaCodecs.video.codec} (Profile: ${mediaCodecs.video.profile})`
      );
      console.log(
        ` Audio: ${mediaCodecs.audio.codec} (Sample Rate: ${mediaCodecs.audio.sampleRate}, Channels: ${mediaCodecs.audio.channels})`
      );
      // Send audio config to client (for URL streaming)
      if (mediaCodecs.audio.codec) {
        let audioConfig = {
          codec: mediaCodecs.audio.codec,
          sampleRate: mediaCodecs.audio.sampleRate || 48000,
          numberOfChannels: mediaCodecs.audio.channels || 2,
        };
        if (
          audioConfig.codec.toLowerCase() === "aac" ||
          audioConfig.codec.toLowerCase() === "mp4a"
        ) {
          audioConfig.codec = `mp4a.40.2`;
        }
        ws.send(JSON.stringify({ type: "audio-config", config: audioConfig }));
      }
    } else {
      ws.close(1008, "Invalid request: src or mode not specified.");
      return;
    }
  } catch (error) {
    console.error(`ERROR: Failed to get media info:`, error.message);
    ws.send(
      JSON.stringify({
        type: "error",
        message: `Failed to get media info: ${error.message}`,
      })
    );
    ws.close(1008, "Failed to get media info");
    return;
  }

  function startFFmpeg() {
    ffVideo?.kill("SIGINT");
    ffAudio?.kill("SIGINT");

    const streamInputOptions = [
      "-fflags",
      "nobuffer",
      "-flags",
      "low_delay",
      "-tune",
      "zerolatency",
      "-flush_packets",
      "1",
      "-max_delay",
      "0",
      "-copyts",
      "-vsync",
      "passthrough",
    ];

    let videoArgs = [],
      audioArgs = [],
      inputSource,
      stdioOptions;

    if (mode === "upload") {
      inputSource = "pipe:0";
      // Node.js child_process.spawn는 기본적으로 [stdin, stdout, stderr]를 제공합니다.
      // `pipe:3`과 `pipe:4`는 표준 입출력 파이프가 아니라, 추가적인 파일 디스크립터를 사용하겠다는 의미입니다.
      // 이 경우 `stdio` 옵션은 배열 형태로 전달되어야 하며, 각 인덱스는 파일 디스크립터 번호에 해당합니다.
      // 0: stdin, 1: stdout, 2: stderr, 3: fd3, 4: fd4
      stdioOptions = { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] }; // stdin, stdout(ffVideo), stderr(ffVideo), stdout(ffAudio), stderr(ffAudio)

      // Video codec handling (이전과 동일하게 유지)
      if (
        mediaCodecs.video.codec &&
        WEB_SUPPORTED_VIDEO_CODECS.includes(
          mediaCodecs.video.codec.toLowerCase()
        ) &&
        !["h264", "avc1"].includes(mediaCodecs.video.codec.toLowerCase())
      ) {
        console.log(
          `Video codec ${mediaCodecs.video.codec} is supported, copying.`
        );
        videoArgs.push("-c:v", "copy");
      } else if (
        mediaCodecs.video.codec &&
        ["h264", "avc1"].includes(mediaCodecs.video.codec.toLowerCase())
      ) {
        console.log(
          `Video codec ${mediaCodecs.video.codec} is supported, copying with bsf.`
        );
        videoArgs.push("-c:v", "copy", "-bsf:v", "h264_mp4toannexb,dump_extra");
      } else {
        console.log(
          `Video codec ${mediaCodecs.video.codec} is not supported, transcoding to H.264.`
        );
        videoArgs.push(
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-g",
          "30",
          "-crf",
          "28"
        );
      }
      videoArgs.push("-f", "h264");
      videoArgs.push("pipe:4"); // Video output to fd 4

      // ✨ Audio codec handling (이 부분만 변경)
      if (
        mediaCodecs.audio.codec &&
        WEB_SUPPORTED_AUDIO_CODECS.includes(
          mediaCodecs.audio.codec.toLowerCase()
        )
      ) {
        console.log(
          `Audio codec ${mediaCodecs.audio.codec} is supported, copying.`
        );
        audioArgs.push("-c:a", "copy");
        // AAC 코덱의 경우 ADTS to ASC 변환 필터 추가 (브라우저 호환성 개선)
        if (
          mediaCodecs.audio.codec.toLowerCase() === "aac" ||
          mediaCodecs.audio.codec.toLowerCase() === "mp4a"
        ) {
          audioArgs.push("-bsf:a", "aac_adtstoasc");
        }
      } else {
        console.log(
          `Audio codec ${mediaCodecs.audio.codec} is not supported, transcoding to AAC.`
        );
        audioArgs.push(
          "-c:a",
          "aac",
          "-b:a",
          "128k", // 128k 비트레이트 유지 (이전 요청)
          "-ar",
          mediaCodecs.audio.sampleRate
            ? String(mediaCodecs.audio.sampleRate)
            : "48000", // 원본 샘플 레이트 사용 또는 48000Hz 기본값
          "-ac",
          mediaCodecs.audio.channels ? String(mediaCodecs.audio.channels) : "2" // 원본 채널 수 사용 또는 2채널 기본값
        );
      }
      audioArgs.push("-f", "adts"); // AAC를 ADTS 컨테이너로 출력
      audioArgs.push("pipe:3"); // Audio output to fd 3

      ffVideo = spawn(
        ffmpegBin,
        [
          "-ss",
          `${currentSeek}`,
          "-re",
          "-i",
          inputSource,
          "-map",
          "0:v:0",
          ...streamInputOptions,
          ...videoArgs,
        ],
        stdioOptions
      );
      ffAudio = spawn(
        ffmpegBin,
        [
          "-ss",
          `${currentSeek}`,
          "-re",
          "-i",
          inputSource,
          "-vn",
          "-map",
          "0:a:0",
          ...streamInputOptions,
          ...audioArgs,
        ],
        stdioOptions
      );

      // Re-feed the initial chunks that were consumed by ffprobe
      console.log(
        `FFmpeg 시작. 버퍼링된 ${initialUploadChunks.length}개 청크 전송 시작...`
      );
      for (const chunk of initialUploadChunks) {
        if (ffVideo.stdin && !ffVideo.stdin.writableEnded) {
          ffVideo.stdin.write(chunk);
        }
        if (ffAudio.stdin && !ffAudio.stdin.writableEnded) {
          ffAudio.stdin.write(chunk);
        }
      }
      initialUploadChunks = []; // 사용 후 버퍼 비우기
      console.log("버퍼링된 청크 전송 완료.");

      // Attach listener for subsequent messages from client
      ws.on("message", (data) => {
        if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
          if (ffVideo.stdin && !ffVideo.stdin.writableEnded) {
            ffVideo.stdin.write(data);
          }
          if (ffAudio.stdin && !ffAudio.stdin.writableEnded) {
            ffAudio.stdin.write(data);
          }
        } else {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === "eof") {
              if (ffVideo.stdin && !ffVideo.stdin.writableEnded) {
                ffVideo.stdin.end();
              }
              if (ffAudio.stdin && !ffAudio.stdin.writableEnded) {
                ffAudio.stdin.end();
              }
            }
          } catch (e) {
            console.warn(
              "Worker JSON message parsing error (message reception):",
              e.message
            );
          }
        }
      });
    } else {
      // URL streaming mode (이전과 동일하게 유지)
      if (!src || !/^https?:\/\//.test(src)) {
        ws.close(1008, "Invalid src");
        return;
      }
      inputSource = src;
      stdioOptions = { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] }; // Adjusted for consistency

      // URL 스트리밍 모드에서도 오디오 코덱 처리 로직 반영
      videoArgs.push(
        "-ss",
        `${currentSeek}`,
        "-re",
        "-i",
        inputSource,
        ...streamInputOptions,
        "-map",
        "0:v:0"
      );
      audioArgs.push(
        "-ss",
        `${currentSeek}`,
        "-re",
        "-i",
        inputSource,
        ...streamInputOptions,
        "-vn",
        "-map",
        "0:a:0"
      );

      if (
        mediaCodecs.video.codec &&
        WEB_SUPPORTED_VIDEO_CODECS.includes(
          mediaCodecs.video.codec.toLowerCase()
        )
      ) {
        console.log(
          `Video codec ${mediaCodecs.video.codec} is supported, copying.`
        );
        videoArgs.push("-c:v", "copy");
        if (["h264", "avc1"].includes(mediaCodecs.video.codec.toLowerCase())) {
          videoArgs.push("-bsf:v", "h264_mp4toannexb,dump_extra");
        }
        videoArgs.push("-f", "h264");
      } else {
        console.log(
          `Video codec ${mediaCodecs.video.codec} is not supported, transcoding to H.264.`
        );
        videoArgs.push(
          "-loglevel",
          "debug",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-g",
          "30",
          "-crf",
          "28",
          "-f",
          "h264"
        );
      }
      videoArgs.push("pipe:4");

      // ✨ URL 스트리밍 모드 오디오 코덱 처리 로직 반영 (upload 모드와 동일하게)
      if (
        mediaCodecs.audio.codec &&
        WEB_SUPPORTED_AUDIO_CODECS.includes(
          mediaCodecs.audio.codec.toLowerCase()
        )
      ) {
        console.log(
          `Audio codec ${mediaCodecs.audio.codec} is supported, copying.`
        );
        audioArgs.push("-c:a", "copy");
        if (
          mediaCodecs.audio.codec.toLowerCase() === "aac" ||
          mediaCodecs.audio.codec.toLowerCase() === "mp4a"
        ) {
          audioArgs.push("-bsf:a", "aac_adtstoasc");
        }
        audioArgs.push("-f", "adts");
      } else {
        console.log(
          `Audio codec ${mediaCodecs.audio.codec} is not supported, transcoding to AAC.`
        );
        audioArgs.push(
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-ar",
          mediaCodecs.audio.sampleRate
            ? String(mediaCodecs.audio.sampleRate)
            : "48000",
          "-ac",
          mediaCodecs.audio.channels ? String(mediaCodecs.audio.channels) : "2",
          "-f",
          "adts"
        );
      }
      audioArgs.push("pipe:3");

      ffVideo = spawn(ffmpegBin, videoArgs, stdioOptions);
      ffAudio = spawn(ffmpegBin, audioArgs, stdioOptions);

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "seek" && typeof msg.time === "number") {
            currentSeek = msg.time;
            ws.send(JSON.stringify({ type: "reset" }));
            startFFmpeg(); // Restart to apply seek
          }
        } catch (e) {
          console.warn("Worker JSON message parsing error (seek):", e.message);
        }
      });
    }

    const sendPacket = (type, chunk) => {
      if (ws.readyState === ws.OPEN) {
        const tsBuf = Buffer.alloc(8);
        tsBuf.writeBigUInt64BE(BigInt(Date.now()));
        ws.send(Buffer.concat([Buffer.from([type]), tsBuf, chunk]));
      }
    };

    // Note: ffVideo.stdio[4] and ffAudio.stdio[3] are specific to the `stdioOptions` array
    // [stdin, stdout, stderr, fd3, fd4] structure.
    // If you changed to pipe:1 for both, you'd use ffVideo.stdout and ffAudio.stdout directly.
    ffVideo.stdio[4]?.on("data", (chunk) => sendPacket(1, chunk));
    ffVideo.stdio[4]?.on("error", (err) =>
      console.error("FFmpeg Video Stream Pipe Error:", err)
    );
    ffAudio.stdio[3]?.on("data", (chunk) => sendPacket(2, chunk));
    ffAudio.stdio[3]?.on("error", (err) =>
      console.error("FFmpeg Audio Stream Pipe Error:", err)
    );

    ffVideo.stderr.on("data", (data) =>
      console.error(`FFmpeg Video stderr: ${data.toString()}`)
    );
    ffAudio.stderr.on("data", (data) =>
      console.error(`FFmpeg Audio stderr: ${data.toString()}`)
    );

    ffVideo.on("close", (code) => {
      console.log(`FFmpeg video process exited with code ${code}`);
      if (code !== 0) {
        console.error(`ERROR: FFmpeg video stream exit error (code: ${code})`);
        ws.send(
          JSON.stringify({
            type: "error",
            message: `Video stream error (code: ${code})`,
          })
        );
        ws.close(1011, `Video stream error (code: ${code})`);
      }
    });
    ffAudio.on("close", (code) => {
      console.log(`FFmpeg audio process exited with code ${code}`);
      if (code !== 0) {
        console.error(`ERROR: FFmpeg audio stream exit error (code: ${code})`);
        ws.send(
          JSON.stringify({
            type: "error",
            message: `Audio stream error (code: ${code})`,
          })
        );
        ws.close(1011, `Audio stream error (code: ${code})`);
      }
    });

    ffVideo.on("error", (err) =>
      console.error("Failed to start FFmpeg video process:", err)
    );
    ffAudio.on("error", (err) =>
      console.error("Failed to start FFmpeg audio process:", err)
    );
  }

  startFFmpeg();

  ws.on("close", () => {
    console.log(
      "WebSocket connection closed. Attempting to terminate FFmpeg processes."
    );
    ffVideo?.kill("SIGINT");
    ffAudio?.kill("SIGINT");
  });

  ws.on("error", (err) => {
    console.error("WebSocket Error:", err);
    ffVideo?.kill("SIGINT");
    ffAudio?.kill("SIGINT");
  });
});

server.listen(PORT, () => {
  console.log(`HTTP ▶ http://localhost:${PORT}`);
  console.log(`WS   ▶ ws://localhost:${PORT}/stream?src=<URL>`);
  console.log(`     ▶ ws://localhost:${PORT}/stream?mode=upload`);
});
