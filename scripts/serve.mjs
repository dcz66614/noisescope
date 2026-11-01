// serve.mjs — NoiseScope 静态发布包的本地服务，只用 Node 内建模块。
// 用法（源码根或静态包根）：
//   node scripts/serve.mjs dist 4173        # 源码根（package.json 的 serve 脚本即此）
//   node serve.mjs dist 4173                # 静态包根（serve.mjs 与 dist/ 平级）
//   node scripts/serve.mjs                  # 默认 dist + 4173
// 只绑定 127.0.0.1，不对外网监听；只提供 root 目录内的文件，禁止目录穿越。
// 无 npm 运行依赖：解压静态包后只要有 Node 24 即可运行。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIME = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".csv", "text/csv; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".webm", "video/webm"],
  [".wasm", "application/wasm"],
  [".ico", "image/x-icon"],
]);

export function resolveInside(root, requestPath) {
  // 返回 root 内的绝对路径，越界时返回 null。调用方据此返回 404，绝不读 root 外文件。
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const clean = decoded.replace(/\\/g, "/");
  const resolved = path.resolve(root, "." + clean);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

export function createStaticServer(root) {
  const rootAbs = path.resolve(root);
  return createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        res.end("Method Not Allowed");
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      let file = resolveInside(rootAbs, url.pathname);
      if (file === null) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      if (existsSync(file) && statSync(file).isDirectory()) {
        file = path.join(file, "index.html");
      }
      if (!existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const type = MIME.get(ext) || "application/octet-stream";
      const data = await readFile(file);
      res.writeHead(200, {
        "content-type": type,
        "content-length": data.length,
        "cache-control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      });
      res.end(req.method === "HEAD" ? undefined : data);
    } catch {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || "dist";
  const port = Number(process.argv[3] || process.env.PORT || 4173);
  const rootAbs = path.resolve(root);
  if (!existsSync(rootAbs) || !statSync(rootAbs).isDirectory()) {
    console.error(`serve: root 不存在或不是目录：${rootAbs}（先跑 npm run build 生成 dist）`);
    process.exit(1);
  }
  const server = createStaticServer(rootAbs);
  server.listen(port, "127.0.0.1", () => {
    console.log(`NoiseScope serving ${rootAbs} at http://127.0.0.1:${port}/`);
  });
}
