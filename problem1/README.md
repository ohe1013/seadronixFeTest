````markdown
# Fibonacci 호출 횟수 계산기

이 저장소는 “`fibonacci(N)`을 호출했을 때 0과 1이 각각 몇 번 출력되는지” 계산하는 프로그램을 다양한 환경에서 실행할 수 있도록 구현한 예제입니다.

---

## 📝 문제 설명

```text
다음 소스는 N 번째 피보나치 수를 구하는 C++ 함수이다.
int fibonacci(int n) {
  if (n == 0) {
    printf("0");
    return 0;
  } else if (n == 1) {
    printf("1");
    return 1;
  } else {
    return fibonacci(n‐1) + fibonacci(n‐2);
  }
}

fibonacci(3)을 호출하면:
• fibonacci(3)은 fibonacci(2)와 fibonacci(1) (첫 번째 호출)을 호출한다.
• fibonacci(2)는 fibonacci(1) (두 번째 호출)과 fibonacci(0)을 호출한다.
…
이때 1은 2번, 0은 1번 출력된다.

T개의 테스트 케이스가 주어질 때,
각 N에 대해 fibonacci(N) 호출 시 0과 1이 출력되는 횟수를 구해서 출력하세요.
```
````

---

## 📂 파일 구조

```
/
├── index.html            # 브라우저에서 실행 가능한 인터랙티브 버전
├── solve.js              # 핵심 로직 (Node.js & 브라우저 양쪽에서 사용)
├── node-interactive.js   # stdin/stdout을 이용한 대화형 CLI 실행 스크립트
├── node-runner.js        # 파일 입력(/dev/stdin) 방식으로 실행하는 스크립트
└── README.md             # 프로젝트 설명 (이 파일)
```

---

## ⚙️ 실행 방법

### 1) 브라우저 버전 (index.html)

1. 프로젝트 루트에서 간단한 HTTP 실행

   ```bash
    start index.html
   ```

2. 값에 입력

   ```
   3
   0
   1
   3
   ```

3. 출력 결과:

   ```
   1 0
   0 1
   1 2
   ```

### 2) 대화형 CLI (node-interactive.js)

```bash
node node-interactive.js
```

그 후 표준 입력으로 테스트케이스 입력:

```
3
0
1
3
```

엔터 치면 즉시 결과가 화면에 출력됩니다.

### 3) 파일 입력 방식 (node-runner.js)

```bash
node node-runner.js input.txt
```

- `input.txt` 예시:

  ```
  3
  0
  1
  3
  ```

- 출력:

  ```
  1 0
  0 1
  1 2
  ```

---

## 📖 구현 설명 (solve.js)

- **DP(동적 계획법)** 을 활용하여 `cnt[n] = { zeroCount, oneCount }` 배열을 미리 계산
- `cnt[0] = {0 → 1번, 1 → 0번}`,
  `cnt[1] = {0 → 0번, 1 → 1번}` 을 초기값으로 두고
- `cnt[i].zero = cnt[i-1].zero + cnt[i-2].zero`
  `cnt[i].one  = cnt[i-1].one  + cnt[i-2].one`
- N은 최대 40이므로 미리 0..40까지 계산해두면 각 테스트 케이스에 O(1) 응답

```js
function solve(lines) {
  const T = Number(lines[0]);
  const input = lines.slice(1).map(Number);

  // 미리 DP로 0..40 계산
  const cnt = {
    0: { 0: 1, 1: 0 },
    1: { 0: 0, 1: 1 },
  };
  for (let i = 2; i <= 40; i++) {
    cnt[i] = {
      0: cnt[i - 1][0] + cnt[i - 2][0],
      1: cnt[i - 1][1] + cnt[i - 2][1],
    };
  }

  return input.map((n) => `${cnt[n][0]} ${cnt[n][1]}`);
}

module.exports = solve;
```

---

## ✔️ 요구사항 및 의존

- **Node.js** (v12 이상 권장)
- 브라우저 버전 실행 시 추가 라이브러리 불필요
- CLI 버전 실행을 위해 `readline` 모듈 사용 (`node-interactive.js`)

---

**Author:** 오현근
**Date:** 2025-07-27

```

```
