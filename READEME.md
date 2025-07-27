```markdown
# Multi‑Problem Repository

이 저장소는 다음 두 개의 과제를 포함하고 있습니다:

1. **Problem 1: Fibonacci 호출 횟수 계산기**
2. **Problem 2: Minimal‑Latency A/V Streaming**

각 문제별로 독립된 폴더(`problem1/`, `problem2/`)에 구현체와 README를 제공합니다. 이 최상위 README에서는 전체 구조와 실행 방법을 안내합니다.

---

## 📂 전체 디렉터리 구조

problem1/ # Problem 1: Fibonacci 호출 횟수 계산기
│ ├── index.html
│ ├── solve.js
│ ├── node-interactive.js
│ ├── node-runner.js
│ └── README.md # Problem 1 전용 README
│
problem2/ # Problem 2: Minimal‑Latency A/V Streaming
│ ├── public/
│ │ ├── index.html
│ │ └── decoderWorker.js
│ ├── tools/ffmpeg/bin/ # FFmpeg/ffprobe 바이너리
│ ├── server.js
│ └── README.md # Problem 2 전용 README
│
└── README.md # 이 최상위 README
```

---

## 🚀 실행 방법 요약

### 1. Problem 1: Fibonacci 호출 횟수 계산기

- **브라우저 버전**
  `problem1/` 폴더에서 간단한 HTTP 실행
  `bash
    cd problem1
    start index.html
    `

- **CLI 버전 (Node.js)**
  ```bash
  cd problem1
  # 대화형 모드
  node node-interactive.js
  # 파일 입력 모드
  node node-runner.js input.txt
  ```

### 2. Problem 2: Minimal‑Latency A/V Streaming

1. FFmpeg/ffprobe 바이너리를 `problem2/tools/ffmpeg/bin/` 아래에 배치
2. 종속 모듈 설치

   ```bash
   cd problem2
   npm install
   ```

3. 서버 실행

   ```bash
   node server.js
   ```

4. 브라우저에서 `http://localhost:3000` 접속 → URL 입력 후 “시작” 클릭

---

## 📝 공통 요구사항

- **제출 방식**: GitHub 저장소 링크 제출 또는 전체 소스 압축 제출
- **언어**: JavaScript(Node.js) → 브라우저, CLI 환경 모두 지원
- **의존성**

  - Problem 1: 별도 의존 없음 (Node.js 기본 모듈만 사용)
  - Problem 2: `ws` 패키지, FFmpeg/ffprobe 바이너리

---

## 👤 Author

- **이름**: 오현근
- **날짜**: 2025‑07‑27

---

```

```
