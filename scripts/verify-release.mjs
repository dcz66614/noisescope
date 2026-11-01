// verify-release.mjs — 校验 release.mjs 的产物，不依赖任何 npm 包。
// 用法（源码根）：npm run verify:release  （即 node scripts/verify-release.mjs）
// 校验项（任一项失败即 exit 1，绝不只打印警告就通过）：
//   1. release/ 下两个 zip、SOURCE_MANIFEST.csv、SHA256SUMS.txt、release-manifest.json 齐全，
//      且 SHA256SUMS.txt 与实际文件哈希一致；
//   2. 静态包可解析：含 dist/index.html、serve.mjs、README.md，不含 node_modules、
//      .env、token/credential/secret 类文件；
//   3. 静态包可运行：解压到临时目录，用 Node 内建 serve.mjs 起服务，首页返回 200，
//      JS 的 MIME 正确，目录穿越请求（/%2e%2e/package.json）返回 404；
//   4. 源码包与 SOURCE_MANIFEST.csv 逐文件一致（文件名集合、字节数、SHA-256 均核对）；
//   5. 源码包干净还原：解压到临时目录，跑 npm ci 与 npm run build，dist/index.html 必须生成。
//      如需跳过第 5 步（例如离线环境只做结构校验），设 VERIFY_RELEASE_SKIP_BUILD=1，
//      此时脚本会明确打印“已跳过还原构建”，不声称还原已验证。
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "release");
const failures = [];
function check(ok, message) {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
}
function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 解析 stored ZIP（release.mjs 的写法）：返回 Map<name, Buffer>，并校验 CRC。
function readZip(zipPath) {
  const buf = readFileSync(zipPath);
  if (buf.length < 22 || buf.readUInt32LE(buf.length - 22) !== 0x06054b50) {
    throw new Error(`${zipPath} 没有有效的 ZIP 结束记录`);
  }
  const count = buf.readUInt16LE(buf.length - 12);
  const cdSize = buf.readUInt32LE(buf.length - 10);
  const cdStart = buf.readUInt32LE(buf.length - 6);
  if (cdStart + cdSize > buf.length - 22) throw new Error("中央目录越界");
  const entries = new Map();
  let p = cdStart;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("中央目录签名错误");
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (method !== 0) throw new Error(`不支持的压缩方法 ${method}（本发布只用 stored）`);
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("本地文件头签名错误");
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (crc32(data) !== crc) throw new Error(`CRC 不符：${name}`);
    entries.set(name, Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extract(entries, dir) {
  for (const [name, data] of entries) {
    const target = path.resolve(dir, name);
    if (!target.startsWith(dir + path.sep) && target !== dir) throw new Error(`非法条目路径：${name}`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

function fetchRaw(port, rawPath, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: rawPath, method }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

async function serveSmoke(staticDir) {
  const port = 4191;
  const child = spawn(process.execPath, [path.join(staticDir, "serve.mjs"), path.join(staticDir, "dist"), String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  try {
    let home = null;
    for (let i = 0; i < 50 && !home; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { home = await fetchRaw(port, "/"); } catch { /* 未就绪 */ }
    }
    check(!!home && home.status === 200, `静态包 serve 首页返回 200（实际 ${home?.status ?? "未启动"}）`);
    check(!!home && home.body.toString("utf8").includes("P006"), "静态包首页含 P006 标题");
    // 找一个 dist 内的 JS 文件核对 MIME。
    const { readdirSync } = await import("node:fs");
    const assets = readdirSync(path.join(staticDir, "dist", "assets")).filter((f) => f.endsWith(".js"));
    if (assets.length) {
      const js = await fetchRaw(port, `/assets/${assets[0]}`);
      check(js.status === 200 && String(js.headers["content-type"]).includes("javascript"), "静态包 JS 的 MIME 为 javascript");
    } else {
      check(false, "静态包 dist/assets 内没有 JS 文件");
    }
    const traversal = await fetchRaw(port, "/%2e%2e/package.json");
    check(traversal.status === 404, `目录穿越请求返回 404（实际 ${traversal.status}）`);
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main() {
  const staticZip = path.join(OUT, "noisescope-static.zip");
  const sourceZip = path.join(OUT, "source-release.zip");
  const manifestCsv = path.join(OUT, "SOURCE_MANIFEST.csv");
  const sumsTxt = path.join(OUT, "SHA256SUMS.txt");
  const releaseManifest = path.join(OUT, "release-manifest.json");
  for (const f of [staticZip, sourceZip, manifestCsv, sumsTxt, releaseManifest]) {
    check(existsSync(f), `存在 ${path.relative(ROOT, f)}`);
  }
  if (failures.length) { console.error("verify-release: 产物缺失，停止"); process.exit(1); }

  const sums = readFileSync(sumsTxt, "utf8");
  check(sums.includes(sha256(readFileSync(staticZip))), "SHA256SUMS.txt 与 noisescope-static.zip 哈希一致");
  check(sums.includes(sha256(readFileSync(sourceZip))), "SHA256SUMS.txt 与 source-release.zip 哈希一致");

  const staticEntries = readZip(staticZip);
  check(staticEntries.has("dist/index.html"), "静态包含 dist/index.html");
  check(staticEntries.has("serve.mjs"), "静态包含 serve.mjs");
  check(staticEntries.has("README.md"), "静态包含 README.md");
  check(![...staticEntries.keys()].some((n) => n.includes("node_modules")), "静态包不含 node_modules");
  check(![...staticEntries.keys()].some((n) => /(^|\/)\.env$|token|credential|secret/i.test(n)), "静态包不含 .env / token 类文件");

  const sourceEntries = readZip(sourceZip);
  const lines = readFileSync(manifestCsv, "utf8").trim().split("\n").slice(1);
  const manifest = new Map();
  for (const line of lines) {
    const m = line.match(/^"(.*)",(\d+),([0-9a-f]{64})$/);
    if (!m) { check(false, `SOURCE_MANIFEST.csv 行格式错误：${line}`); continue; }
    manifest.set(m[1], { bytes: Number(m[2]), hash: m[3] });
  }
  check(manifest.size === sourceEntries.size, `源码包文件数与清单一致（包 ${sourceEntries.size}，清单 ${manifest.size}）`);
  let manifestOk = true;
  for (const [name, data] of sourceEntries) {
    const row = manifest.get(name);
    if (!row || row.bytes !== data.length || row.hash !== sha256(data)) { manifestOk = false; break; }
  }
  check(manifestOk, "源码包每个文件与 SOURCE_MANIFEST.csv 的字节数与 SHA-256 一致");
  check(![...sourceEntries.keys()].some((n) => n.startsWith("node_modules/") || n.startsWith("dist/") || n.startsWith("test-results/") || n.startsWith(".git/")), "源码包不含 node_modules / dist / test-results / .git");

  const tmp = mkdtempSync(path.join(os.tmpdir(), "noisescope-verify-"));
  try {
    const staticDir = path.join(tmp, "static");
    mkdirSync(staticDir);
    extract(staticEntries, staticDir);
    await serveSmoke(staticDir);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (process.env.VERIFY_RELEASE_SKIP_BUILD === "1") {
    console.log("注意：VERIFY_RELEASE_SKIP_BUILD=1，已跳过源码包还原构建（不声称还原已验证）");
  } else {
    const tmp2 = mkdtempSync(path.join(os.tmpdir(), "noisescope-restore-"));
    try {
      extract(sourceEntries, tmp2);
      check(existsSync(path.join(tmp2, "package.json")), "还原树含 package.json");
      check(existsSync(path.join(tmp2, "package-lock.json")), "还原树含 package-lock.json");
      try {
        execFileSync("npm", ["ci"], { cwd: tmp2, stdio: "pipe", timeout: 600000 });
        check(true, "还原树 npm ci 通过");
        execFileSync("npm", ["run", "build"], { cwd: tmp2, stdio: "pipe", timeout: 600000 });
        check(existsSync(path.join(tmp2, "dist", "index.html")), "还原树 npm run build 生成 dist/index.html");
      } catch (e) {
        const out = String(e.stdout || "") + String(e.stderr || "") + String(e.message || "");
        check(false, `还原树 npm ci/build 失败：${out.slice(-500)}`);
      }
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  }

  if (failures.length) {
    console.error(`verify-release: FAIL（${failures.length} 项）`);
    process.exit(1);
  }
  console.log("verify-release: PASS");
}

main().catch((e) => {
  console.error(`verify-release: FAIL（异常）：${e.message}`);
  process.exit(1);
});
