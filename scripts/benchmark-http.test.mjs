import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { createBenchmarkHttp } from "./benchmark-http.mjs";

for (const limit of [6, 0]) {
  test(`connection limit ${limit} covers body reception and preserves Range requests`, async () => {
    let active = 0;
    let peak = 0;
    const server = createServer((request, response) => {
      active += 1;
      peak = Math.max(peak, active);
      assert.equal(request.headers.range, "bytes=0-1");
      response.writeHead(206, { "Content-Length": 2, "Content-Range": "bytes 0-1/2" });
      response.write("a");
      setTimeout(() => {
        active -= 1;
        response.end("b");
      }, 40);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const transport = createBenchmarkHttp(limit);
    try {
      const url = `http://127.0.0.1:${server.address().port}/points`;
      const bodies = await Promise.all(Array.from({ length: 12 }, async () => {
        const response = await transport.fetch(url, { headers: { Range: "bytes=0-1" } });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get("Content-Range"), "bytes 0-1/2");
        return response.text();
      }));
      assert.deepEqual(bodies, Array(12).fill("ab"));
      assert.equal(peak, limit || 12);
    } finally {
      transport.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}
