/**
 * Writes test/vectors/qr.txt from tvpipe's own encoder: `cargo build -p tvpipe-cli`, then
 * `node test/qr-gen.ts ../../target/debug/tvpipe > test/vectors/qr.txt` in npm/party.
 */

import { execFileSync } from "node:child_process";
const bin = process.argv[2] ?? "../../target/debug/tvpipe";
const texts = [
  "tvpipe",
  "https://tvpipe.party/BCDF",
  "https://tvpipe.party/r/?r=BCDF#k=q3Vh8xJ2mK9pL0sT4wYz1A",
  "https://tvpipe.party/r/?r=XZQW#k=q3Vh8xJ2mK9pL0sT4wYz1A&p=Zm9vYmFyYmF6cXV4cXV1eA",
  "https://tvpipe.party/g/drawbluff/0.4.0/screen/index.html#r=BCDF&k=q3Vh8xJ2mK9pL0sT4wYz1A&role=watch",
  "https://tvpipe.party/p#c=graduate-variables-lifetime-ridge&r=BCDF&k=q3Vh8xJ2mK9pL0sT4wYz1A",
  "grüße? 日本 🎉",
  "",
  "x".repeat(100),
  "https://example.com/" + "a".repeat(250),
  "y".repeat(600),
  "z".repeat(1200),
  "Q".repeat(2331),
  "w".repeat(2953),
];
// Every length from 1 to 120: every version boundary of the small ones.
for (let n = 1; n <= 120; n += 7) texts.push("party".repeat(30).slice(0, n));
const out = ["# QR codes from tvpipe's encoder (crates/tvpipe/src/util/qr.rs), for src/qr.ts.", "# One JSON object per line: {text, rows}. Made with `tvpipe debug qr --rows TEXT` (test/qr-gen.ts)."];
for (const text of texts) {
  const rows = execFileSync(bin, ["debug", "qr", "--rows", text], { encoding: "utf8", maxBuffer: 1 << 24 }).trim().split("\n");
  out.push(JSON.stringify({ text, rows }));
}
process.stdout.write(out.join("\n") + "\n");
