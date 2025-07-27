// server.js
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

// MIME 타입 맵
const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".mp4": "video/mp4",
};

// 1) HTTP 서버: public 폴더 정적 서빙
const server = http.createServer((req, res) => {
  const urlPath =
    req.url.split("?")[0] === "/" ? "/renderLoop.html" : req.url.split("?")[0];
  const fp = path.join(PUBLIC_DIR, urlPath);
  fs.stat(fp, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404 Not Found");
    }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    fs.createReadStream(fp).pipe(res);
  });
});

// 2) WebSocket 서버: video/audio 분리
const wss = new WebSocketServer({ server, path: "/stream" });

wss.on("connection", (ws, req) => {
  const src = new URL(req.url, `http://${req.headers.host}`).searchParams.get(
    "src"
  );
  if (!src || !/^https?:\/\//.test(src)) {
    ws.close(1008, "Invalid src");
    return;
  }

  let ff; // ✨ 프로세스 하나만 선언
  let currentSeek = 0;
  const ffmpegBin = join(
    __dirname,
    "tools",
    "ffmpeg",
    "bin",
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
  );

  function startFFmpeg() {
    if (ff) ff.kill("SIGINT");

    console.log(`Starting ffmpeg for ${src} at ${currentSeek}s`);

    // ✨ 하나의 FFmpeg 프로세스로 비디오와 오디오를 동시에 처리
    ff = spawn(
      ffmpegBin,
      [
        // ── 전역 / 입력 최적화

        "-ss",
        `${currentSeek}`, // seek 지원,
        "-i",
        src, // 입력 URL or 파일
        "-copyts",
        "-vsync",
        "passthrough",
        "-analyzeduration",
        "0", // 프로브 지연 최소화
        "-probesize",
        "32", // 작은 프로브 크기

        // ── muxer / 인코더 저지연 옵션
        "-fflags",
        "nobuffer", // 내부 버퍼링 최소화
        "-flags",
        "low_delay", // low_delay 모드
        "-tune",
        "zerolatency", // x264 zerolatency (if re-encoding)
        "-flush_packets",
        "1", // 패킷 단위 즉시 flush
        "-max_delay",
        "0", // muxer 최대 지연 0

        // ── 비디오 스트림 → pipe:4
        "-map",
        "0:v:0",
        "-c:v",
        "copy",
        "-bsf:v",
        "h264_mp4toannexb,dump_extra",
        "-f",
        "h264",
        "pipe:4",

        // ── 오디오 스트림 → pipe:5
        "-map",
        "0:a:0",
        "-c:a",
        "aac", // AAC 코덱으로 인코딩
        "-b:a",
        "128k", // 오디오 비트레이트 (예: 128kbps)
        "-f",
        "adts", // AAC ADTS (raw AAC stream with headers)
        "pipe:5",
      ],
      {
        stdio: [
          "pipe", // stdin (unused)
          "pipe", // stdout
          "pipe", // stderr
          "pipe", // pipe:3 (unused)
          "pipe", // pipe:4 (video)
          "pipe", // pipe:5 (audio)
        ],
      }
    );

    const sendPacket = (type, chunk) => {
      if (ws.readyState !== ws.OPEN) return;
      const tsBuf = Buffer.alloc(8);
      tsBuf.writeBigUInt64BE(BigInt(Date.now()));
      const header = Buffer.concat([Buffer.from([type]), tsBuf]);
      ws.send(Buffer.concat([header, chunk]));
    };

    // ▶ 비디오 스트림 처리 (ff.stdio[4])
    ff.stdio[4].on("data", (chunk) => sendPacket(1, chunk));
    // ▶ 오디오 스트림 처리 (ff.stdio[5])
    ff.stdio[5].on("data", (chunk) => sendPacket(2, chunk));

    ff.stderr.on("data", (msg) => console.error("ffmpeg:", msg.toString()));
    ff.on("close", (code) =>
      console.log(`ffmpeg process exited with code ${code}`)
    );
  }

  // 최초 스트림 시작
  startFFmpeg();

  // 클라이언트 seek 요청 처리
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "seek" && typeof msg.time === "number") {
        console.log("→ seek to", msg.time);
        currentSeek = msg.time;
        // 클라이언트가 상태를 리셋할 수 있도록 메시지 전송
        ws.send(JSON.stringify({ type: "reset" }));
        startFFmpeg();
      }
    } catch {}
  });

  ws.on("close", () => {
    if (ff) ff.kill("SIGINT");
  });
});

// 서버 실행
server.listen(PORT, () => {
  console.log(`HTTP ▶ http://localhost:${PORT}`);
  console.log(`WS   ▶ ws://localhost:${PORT}/stream?src=<VIDEO_URL>`);
});
