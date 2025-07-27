function solve(lines) {
  const T = Number(lines[0]);
  const input = lines.slice(1).map(Number);

  const cnt = {};
  cnt[0] = { 0: 1, 1: 0 };
  cnt[1] = { 0: 0, 1: 1 };

  for (let i = 2; i <= 40; i++) {
    cnt[i] = {
      0: cnt[i - 1][0] + cnt[i - 2][0],
      1: cnt[i - 1][1] + cnt[i - 2][1],
    };
  }

  return input.map((n) => `${cnt[n][0]} ${cnt[n][1]}`);
}

module.exports = solve;
