import http from "node:http";
import https from "node:https";

// One shared pool per benchmark makes both readers obey the same per-origin
// HTTP/1.1 connection limit. Sockets stay occupied until the body is received.
// This adapter deliberately accepts direct URLs only (no redirect handling).
export function createBenchmarkHttp(connections = 0) {
  if (!Number.isSafeInteger(connections) || connections < 0) {
    throw new RangeError("connections must be a non-negative integer");
  }
  const options = { keepAlive: true, maxSockets: connections || Infinity };
  const agents = { "http:": new http.Agent(options), "https:": new https.Agent(options) };
  return {
    fetch(url, init = {}) {
      return new Promise((resolve, reject) => {
        const protocol = new URL(url).protocol;
        const client = protocol === "https:" ? https : http;
        const request = client.request(url, {
          agent: agents[protocol],
          method: init.method ?? "GET",
          headers: Object.fromEntries(new Headers(init.headers)),
          signal: init.signal,
        }, (response) => {
          const parts = [];
          response.on("data", (part) => parts.push(part));
          response.on("error", reject);
          response.on("end", () => {
            const status = response.statusCode;
            if (status >= 300 && status < 400) {
              reject(new Error("benchmark requires a direct URL without redirects"));
              return;
            }
            const headers = new Headers();
            for (let i = 0; i < response.rawHeaders.length; i += 2) {
              headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
            }
            const noBody = init.method === "HEAD" || [204, 205, 304].includes(status);
            resolve(new Response(noBody ? null : Buffer.concat(parts), { status, headers }));
          });
        });
        request.on("error", reject);
        request.end();
      });
    },
    close() {
      for (const agent of Object.values(agents)) agent.destroy();
    },
  };
}
