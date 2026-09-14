#!/usr/bin/env node
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createSecureServer } from "node:http2";
import { setTimeout } from "node:timers/promises";
import { extname, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? "8080");
const host = "127.0.0.1";
// Fixed response delay models request latency, not bandwidth or packet-level RTT.
const delayMs = Number(process.argv[4] ?? "0");
if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
  throw new Error("response delay must be a non-negative integer in milliseconds");
}
// Optional certificate and private key enable browser-compatible HTTP/2 over TLS.
const [certificatePath, keyPath] = process.argv.slice(5);
if (Boolean(certificatePath) !== Boolean(keyPath)) throw new Error("Provide both TLS certificate and key paths");
const server = certificatePath ? createSecureServer({
  cert: readFileSync(certificatePath), key: readFileSync(keyPath),
  allowHTTP1: false, settings: { maxConcurrentStreams: 100 },
}) : createServer();
const mime = new Map([[".parquet", "application/vnd.apache.parquet"]]);

server.on("request", async (request, response) => {
  try {
    if (delayMs > 0) await setTimeout(delayMs);
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    const path = resolve(root, `.${pathname}`);
    if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("path escapes root");
    const size = statSync(path).size;
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Timing-Allow-Origin", "*");
    response.setHeader("X-Benchmark-Response-Delay-Ms", String(delayMs));
    response.setHeader("X-Benchmark-Protocol", request.httpVersionMajor === 2 ? "h2" : "http/1.1");
    if (certificatePath) response.setHeader("X-Benchmark-Max-Concurrent-Streams", "100");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range, X-Benchmark-Response-Delay-Ms, X-Benchmark-Protocol, X-Benchmark-Max-Concurrent-Streams");
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
  console.log(`Range server: ${certificatePath ? "https" : "http"}://${host}:${port}/ (root: ${root}, response delay: ${delayMs} ms)`);
});
