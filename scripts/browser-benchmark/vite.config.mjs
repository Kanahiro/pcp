import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const copcRequire = createRequire(require.resolve('copc'));
const viewerRequire = createRequire(resolve(import.meta.dirname, '../../apps/viewer/package.json'));
const three = resolve(dirname(viewerRequire.resolve('three')), 'three.module.js');
const wasm = resolve(dirname(copcRequire.resolve('laz-perf')), 'laz-perf.wasm');
export default {
  root: resolve(import.meta.dirname, '../..'),
  plugins: [{
    name: 'save-browser-benchmark',
    configureServer(server) {
      server.middlewares.use('/__save-browser-benchmark', async (request, response) => {
        if (request.method !== 'POST' || request.headers.origin !== 'http://127.0.0.1:18081') {
          response.writeHead(403).end(); return;
        }
        try {
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (body.length > 5_000_000) throw new Error('Result too large');
          }
          const result = JSON.parse(body);
          if (result.benchmark !== 'browser-http-through-gpu-and-next-frame' || !Array.isArray(result.queries)) throw new Error('Invalid result');
          const day = new Date(result.measuredAt).toISOString().slice(0,10).replaceAll('-','');
          const delay = result.environment?.serverResponseDelayMs;
          if (delay != null && (!Number.isSafeInteger(delay) || delay < 0)) throw new Error("Invalid response delay");
          const path = `/benchmarks/copc-comparison-browser-e2e${Object.values(result.urls).some(url=>!["localhost","127.0.0.1"].includes(new URL(url).hostname))?"-remote":""}${result.environment?.protocol === "h2" ? "-h2" : ""}${delay > 0 ? `-delay${delay}` : ""}-${day}.json`;
          await writeFile(resolve(import.meta.dirname, '../..') + path, body + '\n');
          response.writeHead(200, { 'Content-Type': 'text/plain' }).end(path);
        } catch (error) { response.writeHead(400).end(String(error)); }
      });
    },
  }],
  resolve: { alias: { three } },
  define: { __BENCHMARK_WASM_URL__: JSON.stringify('/@fs/' + wasm) },
  server: { host: '127.0.0.1', port: 18081, strictPort: true },
};
