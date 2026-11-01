// release.mjs — 生成 NoiseScope 的静态包与源码包，不依赖任何 npm 包。
// 用法（源码根）：npm run release  （即 node scripts/release.mjs）
// 前置：必须先跑 npm run build 生成 dist；本脚本不自动构建，dist 缺失即失败，
// 以免把过期 dist 打进发布包。
// 产物（源码根 release/ 目录）：
//   noisescope-static.zip  — dist/ + serve.mjs + README.md + USER_GUIDE.md
//                            + HOW_TO_REPRODUCE.md（解压后只用 Node 24 即可运行）
//   source-release.zip     — 完整第一方源码树（可 npm ci / build 还原）
//   SOURCE_MANIFEST.csv    — 源码包内每个文件的字节数与 SHA-256
//   SHA256SUMS.txt         — 两个 zip 的 SHA-256
//   release-manifest.json  — 本次发布的机器可读记录（Node 版本、文件数、哈希）
// 排除：node_modules、dist（源码包）、test-results、.git、.env、*.log、
//       release/ 自身、以及任何名为 token / credential / secret 的文件。
// 不打包第三方 GPL 源码：本项目第一方代码为 MIT，见 LICENSE；第三方依赖
// 只以 package-lock.json 声明，不随包分发源码，见 THIRD_PARTY_NOTICES.md。
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "release");

const EXCLUDED_DIRS = new Set(["node_modules", "dist", "test-results", ".git", "release"]);
const EXCLUDED_SUFFIXES = [".log"];
const SECRET_NAME = /(^|[^a-z])(token|credential|secret|apikey|api_key)(\.|_|$)/i;

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function collect(dir, base, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      collect(full, rel, out);
    } else if (entry.isFile()) {
      if (EXCLUDED_SUFFIXES.some((s) => entry.name.endsWith(s))) continue;
      if (SECRET_NAME.test(entry.name)) continue;
      if (entry.name === ".env") continue;
      out.push({ rel, full, size: statSync(full).size });
    }
  }
  return out;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

// CRC-32（IEEE），纯 JS 实现，供 stored ZIP 使用。
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

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0xf) << 5) |
    (date.getDate() & 0x1f);
  return { time, day };
}

// 写 stored（不压缩）ZIP：无需外部工具，Linux/Windows 均可用 unzip / Python zipfile 校验。
// entries: [{ name, data: Buffer }]
export function writeZip(entries, outPath) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = dosDateTime(new Date());
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt16LE(now.time, 10);
    header.writeUInt16LE(now.day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    chunks.push(header, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(now.time, 12);
    cd.writeUInt16LE(now.day, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += header.length + nameBuf.length + data.length;
  }
  const cdStart = offset;
  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  writeFileSync(outPath, Buffer.concat([...chunks, ...central, eocd]));
}

function main() {
  const distIndex = path.join(ROOT, "dist", "index.html");
  if (!existsSync(distIndex)) {
    fail("dist/index.html 不存在：先跑 npm run build，再跑 npm run release。");
  }
  for (const doc of ["README.md", "USER_GUIDE.md", "HOW_TO_REPRODUCE.md", "scripts/serve.mjs"]) {
    if (!existsSync(path.join(ROOT, doc))) fail(`缺少发布必需文件：${doc}`);
  }
  mkdirSync(OUT, { recursive: true });

  // 静态包：dist 全部 + 运行脚本与说明，不含源码、不含 node_modules。
  const staticFiles = collect(path.join(ROOT, "dist"), "dist", []);
  const staticEntries = [
    ...staticFiles.map(({ rel, full }) => ({ name: rel, data: readFileSync(full) })),
    { name: "serve.mjs", data: readFileSync(path.join(ROOT, "scripts", "serve.mjs")) },
    { name: "README.md", data: readFileSync(path.join(ROOT, "README.md")) },
    { name: "USER_GUIDE.md", data: readFileSync(path.join(ROOT, "USER_GUIDE.md")) },
    {
      name: "HOW_TO_REPRODUCE.md",
      data: readFileSync(path.join(ROOT, "HOW_TO_REPRODUCE.md")),
    },
  ];
  const staticZip = path.join(OUT, "noisescope-static.zip");
  writeZip(staticEntries, staticZip);

  // 源码包：完整第一方树（排除规则见顶部），含 .nvmrc 以锁定 Node 版本。
  const sourceFiles = collect(ROOT, "", []).filter(
    (f) => !f.rel.startsWith("release/"),
  );
  const sourceEntries = sourceFiles.map(({ rel, full }) => ({
    name: rel,
    data: readFileSync(full),
  }));
  const sourceZip = path.join(OUT, "source-release.zip");
  writeZip(sourceEntries, sourceZip);

  const manifestLines = ["path,bytes,sha256"];
  for (const { rel, full, size } of sourceFiles) {
    manifestLines.push(`${JSON.stringify(rel)},${size},${sha256(readFileSync(full))}`);
  }
  writeFileSync(path.join(OUT, "SOURCE_MANIFEST.csv"), manifestLines.join("\n") + "\n");
  const sums = [
    `${sha256(readFileSync(staticZip))}  noisescope-static.zip`,
    `${sha256(readFileSync(sourceZip))}  source-release.zip`,
  ].join("\n") + "\n";
  writeFileSync(path.join(OUT, "SHA256SUMS.txt"), sums);
  const manifest = {
    project: "P006 noisescope",
    node: process.version,
    staticZip: { files: staticEntries.length, bytes: statSync(staticZip).size, sha256: sha256(readFileSync(staticZip)) },
    sourceZip: { files: sourceEntries.length, bytes: statSync(sourceZip).size, sha256: sha256(readFileSync(sourceZip)) },
    sourceFiles: sourceFiles.length,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(OUT, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`release: static ${staticEntries.length} files -> ${staticZip}`);
  console.log(`release: source ${sourceEntries.length} files -> ${sourceZip}`);
  console.log(`release: manifest + sums written to ${OUT}`);
}

main();
