const fs = require("fs");
const solve = require("./solve");

const inputFile = process.argv[2];
let lines;

if (inputFile) {
  // 파일명 지정된 경우
  try {
    lines = fs.readFileSync(inputFile, "utf-8").trim().split("\n");
  } catch (e) {
    console.error(`❌ 파일을 읽을 수 없습니다: ${inputFile}`);
    process.exit(1);
  }
} else {
  lines = fs.readFileSync("/dev/stdin", "utf-8").trim().split("\n");
}

solve(lines).forEach((line) => console.log(line));
