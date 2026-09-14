import { Las } from 'copc';
const wasmUrl = __BENCHMARK_WASM_URL__;
import { memorySource, runParquet, runCopc } from './readers.js';
import reference from '../../benchmarks/copc-comparison-load-20260914.json';
import { aggregate } from '../benchmark-common.mjs';

self.onmessage = async ({ data: environment }) => {
  try {
    self.postMessage({ status: 'ファイルとWASMを事前取得中（計測外）' });
    const buffers = {};
    for (const format of ['parquet','copc']) {
      const response = await fetch('/'+reference.dataset[format], { cache: 'no-store' });
      if (!response.ok) throw new Error(`Input fetch: ${response.status}`);
      buffers[format] = await response.arrayBuffer();
      if (buffers[format].byteLength !== reference.dataset[format+'Bytes']) throw new Error('Input size mismatch');
    }
    const decoders = await Promise.all(Array.from({ length: 4 },()=>Las.PointData.createLazPerf({ locateFile: ()=>wasmUrl })));
    const queries = [];
    for (const original of reference.queries) {
      const query = { name: original.name, bounds: { min: original.bounds.slice(0,3), max: original.bounds.slice(3) } };
      const samples = { parquet: [], copc: [] };
      for (let run=0;run<6;run++) {
        for (const format of run%2 ? ['copc','parquet'] : ['parquet','copc']) {
          self.postMessage({ status: `${query.name}: ${format} ${run===0?'warmup':`${run}/5`}` });
          const { chunks, metadata, ...sample } = format==='parquet' ? await runParquet(memorySource(buffers.parquet),query) : await runCopc(memorySource(buffers.copc),query,decoders);
          if (sample.pointsMatched !== original[format].pointsMatched || sample.outputBytes !== sample.pointsMatched*18) throw new Error('Output count or buffer size mismatch');
          if (sample.bytesRead !== original[format].totalBytesFetched) throw new Error('Source byte count mismatch');
          if (run) samples[format].push(sample);
        }
      }
      queries.push({ name: query.name, bounds: original.bounds, parquet: aggregate(samples.parquet), copc: aggregate(samples.copc), samples });
    }
    self.postMessage({ status: '完了：全試行で点数・出力配列サイズ・取得バイト数を検証済み', result: {
      benchmark: 'browser-memory-open-through-xyzrgb', measuredAt: new Date().toISOString(),
      environment: { ...environment, context: 'dedicated Worker', repeats: 5, warmup: 1, lazPerfInstances: 4,
        transport: 'preloaded ArrayBuffers; copies per Range, no network inside timer',
        exclusions: 'input preload, module/decoder startup, GPU upload, rendering; not CPU-only (includes copies and allocations)' },
      dataset: reference.dataset, lod: reference.lod, queries,
    } });
  } catch (error) { self.postMessage({ failed: true, status: `失敗: ${error.stack ?? error}` }); }
};
