#!/usr/bin/env node
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? "8080");
const host = "127.0.0.1";
const mime = new Map([[".parquet", "application/vnd.apache.parquet"]]);

createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const path = resolve(root, `.${pathname}`);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("path escapes root");
    const size = statSync(path).size;
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range");
    response.setHeader("Content-Type", mime.get(extname(path)) ?? "application/octet-stream");

    if (request.method === "HEAD") {
      response.setHeader("Content-Length", size);
      response.end();
      return;
    }

    const match = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) {
      response.writeHead(200, { "Content-Length": size });
      createReadStream(path).pipe(response);
      return;
    }
    const start = Number(match[1]);
    const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    if (start > end || start >= size) {
      response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    response.writeHead(206, {
      "Content-Length": end - start + 1,
      "Content-Range": `bytes ${start}-${end}/${size}`,
    });
    createReadStream(path, { start, end }).pipe(response);
  } catch {
    response.writeHead(404).end("not found\n");
  }
}).listen(port, host, () => {
  console.log(`Range server: http://${host}:${port}/ (root: ${root})`);
});
