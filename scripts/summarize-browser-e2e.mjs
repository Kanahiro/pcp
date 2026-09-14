#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: node scripts/summarize-browser-e2e.mjs INPUT.json OUTPUT.json');
const source = JSON.parse(await readFile(input, 'utf8'));
const phaseDefinitions = {
  startupAndDeliveryMs: '起動・初期化・転送等（dataReadyMs − loadElapsedMs − bufferBuildMsの残差）',
  metadataOpenMs: 'メタデータ取得・解析（Parquetのdecoder初期化も含む）',
  queryMs: '点データ通信・展開・bbox判定・XYZRGB配列生成',
  colorAndBufferMs: '描画用バッファ生成・色変換',
  sceneAndFrameWaitMs: 'メインスレッドのscene準備・描画開始フレーム待ち',
  renderAndGpuMs: '描画命令・GPU転送・GPU完了待ち',
  nextFrameWaitMs: 'GPU完了後の次フレーム待ち',
};
function phases(sample) {
  const result = {
    startupAndDeliveryMs: sample.dataReadyMs - sample.loadElapsedMs - sample.bufferBuildMs,
    metadataOpenMs: sample.openElapsedMs,
    queryMs: sample.loadElapsedMs - sample.openElapsedMs,
    colorAndBufferMs: sample.bufferBuildMs,
    sceneAndFrameWaitMs: sample.gpuCompleteMs - sample.dataReadyMs - sample.renderAndGpuMs,
    renderAndGpuMs: sample.renderAndGpuMs,
    nextFrameWaitMs: sample.frameBoundaryMs - sample.gpuCompleteMs,
  };
  if (Object.values(result).some(v => !Number.isFinite(v) || v < -0.001)) throw new Error('Invalid phase duration');
  const sum = Object.values(result).reduce((a,b)=>a+b,0);
  if (Math.abs(sum - sample.frameBoundaryMs) > 0.001) throw new Error('Phase sum does not match total');
  return result;
}
const queries = source.queries.map(query => ({
  name: query.name,
  ...Object.fromEntries(['parquet','copc'].map(format => {
    const samples = query.samples[format];
    if (samples.length % 2 !== 1) throw new Error('An odd sample count is required to select an actual median trial');
    const order = samples.map((s,index)=>({index,total:s.frameBoundaryMs})).sort((a,b)=>a.total-b.total);
    const selected = order[Math.floor(order.length/2)].index;
    return [format, { selectedSampleIndex:selected, totalMs:samples[selected].frameBoundaryMs,
      phases:phases(samples[selected]), samples:samples.map(phases) }];
  })),
}));
const totals = Object.fromEntries(['parquet','copc'].map(format => [format, {
  totalMs:queries.reduce((n,q)=>n+q[format].totalMs,0),
  phases:Object.fromEntries(Object.keys(phaseDefinitions).map(key=>[key,queries.reduce((n,q)=>n+q[format].phases[key],0)])),
}]));
const result = { source: input, measuredAt:source.measuredAt,
  aggregation:'For each query/format, select the actual trial at the median total duration, then use that same trial for all phases; totals sum those trials. Phases are not independent medians.',
  limitations:'Network and decoding overlap and are not separated. Startup/delivery is a residual including COPC explicit decoder initialization; WebGL initialization overlaps worker work. Next frame is not physical display scan-out.',
  phaseDefinitions, queries, totals };
await writeFile(output,JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(totals,null,2));
