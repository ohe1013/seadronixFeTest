# 최소 지연 영상 스트리밍 페이지

이 프로젝트는 FFmpeg를 활용하여 외부 라이브러리 없이 웹상에서 실시간 영상 스트리밍 및 디코딩 기능을 구현하고, 수신부터 화면 출력까지의 지연 시간을 측정하여 오버레이로 표시하는 최소 지연(latency) 페이지를 제공합니다.

## 주요 기능

1. **영상 스트리밍**: 로컬 파일 업로드 또는 URL 입력을 통해 영상을 스트리밍하고 WebSocket 및 FFmpeg를 통해 디코딩하여 `<canvas>`에 출력합니다.
2. **지연 시간 측정**: 네트워크 전송 지연(Network Latency), 디코딩·렌더링 지연(Processing Latency), 서버 종단간 지연(Server E2E Latency)을 프레임 위에 오버레이로 실시간 표시합니다.
3. **외부 라이브러리 최소화**: FFmpeg 외에는 별도의 외부 라이브러리를 사용하지 않고 순수 자바스크립트 및 Web API만으로 구현되었습니다.

## 설치 및 실행

```bash
# 레포지토리 클론
git clone <REPO_URL>
cd <REPO_FOLDER>

# 의존성 설치
npm install

# 서버 실행
node simple-server.js
# 기본 포트: 3000

예시파일 public의 mp4 파일

http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4

http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4

http://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4
활용

# 웹 브라우저에서 http://localhost:3000 접속
```

## 코드 구조

```
project-root/
├─ public/              # HTML, JS, Worker 스크립트 등 정적 파일
│  ├─ index.html
│  ├─ main.js
│  └─ decoderWorker.js  # WebCodecs 기반 디코더 로직
├─ tools/ffmpeg/bin/    # FFmpeg 및 FFprobe 바이너리
├─ server.js            # HTTP + WebSocket 서버 구현 (Node.js)
├─ package.json
└─ README.md            # 프로젝트 설명
```

## 제한 사항 (Limitations)

- **오디오 잡음(crackle) 문제**: WebCodecs AudioDecoder 및 ADTS 처리 과정에서 일부 클라이언트 환경에서 소리가 지지직 거리는 현상이 발생할 수 있습니다.
- **제한된 코덱 지원**

## 향후 개선 방향

- 코덱 지원 확장: 추가 코덱(HEVC, WMV 등) 디코딩 로직 및 브라우저 호환성 보강
- 오디오 안정화: AudioDecoder 버퍼 관리 개선 및 잡음 제거 필터링 적용
- 버퍼링 최적화: 적응형 버퍼 크기 조절을 통해 지연 시간 최소화 및 안정성 향상
- UI/UX 개선: 스트리밍 상태 및 통계 정보를 시각화하여 사용자 경험 강화
- 백그라운드 갔을때 버그 발생

---

**Author**: 오현근

**Date**: 2025-07-27
