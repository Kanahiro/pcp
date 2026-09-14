import { Las } from 'copc';
import { runParquet, runCopc } from './readers.js';
import { buildPointBuffers } from '../../apps/viewer/src/point-buffer.ts';

self.onmessage = async ({ data: { format, url, query } }) => {
  try {
    performance.setResourceTimingBufferSize(2000);
    const metrics = { bytesRead: 0, ranges: 0, headRequests: 0, serverResponseDelayMs: null, serverProtocol: null, maxConcurrentStreams: null };
    const networkFetch = async (_url, init = {}) => {
      const response = await fetch(url, { ...init, cache: 'no-store' });
      metrics.serverProtocol = response.headers.get('X-Benchmark-Protocol');
      const streams = response.headers.get('X-Benchmark-Max-Concurrent-Streams');
      metrics.maxConcurrentStreams = streams === null ? null : Number(streams);
      const delay = response.headers.get('X-Benchmark-Response-Delay-Ms');
      if (delay !== null) metrics.serverResponseDelayMs = Number(delay);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (init.method === 'HEAD') metrics.headRequests++;
      else {
        if (response.status !== 206) throw new Error('HTTP Range support required');
        metrics.ranges++;
        metrics.bytesRead += Number(response.headers.get('Content-Length'));
      }
      return response;
    };
    const getter = async (begin,end) => {
      const response = await networkFetch(url,{ headers: { Range: `bytes=${begin}-${end-1}` } });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== end-begin) throw new Error('Short Range body');
      return bytes;
    };
    const source = { fetch: networkFetch, getter, metrics };
    const started = performance.now();
    const decoders = format === 'copc' ? await Promise.all(Array.from({length:4},()=>Las.PointData.createLazPerf({locateFile:()=>__BENCHMARK_WASM_URL__}))) : [];
    const decoderInitMs = performance.now()-started;
    const result = format === 'parquet' ? await runParquet(source,query) : await runCopc(source,query,decoders);
    const conversionStarted = performance.now();
    const buffers = result.chunks.map(chunk=>buildPointBuffers(chunk,result.metadata,'rgb'));
    const bufferBuildMs = performance.now()-conversionStarted;
    const resources = performance.getEntriesByType('resource').filter(r=>r.name===url).map(r=>({
      startTime:r.startTime,duration:r.duration,nextHopProtocol:r.nextHopProtocol,
      transferSize:r.transferSize,encodedBodySize:r.encodedBodySize,
    }));
    const { chunks, metadata, ...sample } = result;
    self.postMessage({ buffers, metadata, sample: { ...sample, decoderInitMs, bufferBuildMs, headRequests:metrics.headRequests, serverResponseDelayMs:metrics.serverResponseDelayMs, serverProtocol:metrics.serverProtocol, maxConcurrentStreams:metrics.maxConcurrentStreams, resources } },
      buffers.flatMap(b=>[b.quantizedPositions.buffer,b.colors.buffer]));
  } catch (error) { self.postMessage({error:String(error.stack??error)}); }
};
