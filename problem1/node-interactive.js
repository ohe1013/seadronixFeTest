const readline = require("readline");
const solve = require("./solve");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const input = [];

rl.on("line", (line) => {
  input.push(line.trim());
}).on("close", () => {
  solve(input).forEach((line) => console.log(line));
});
