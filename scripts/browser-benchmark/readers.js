import { Copc } from 'copc';
import { PointCloudParquet } from '../../packages/browser/dist/index.js';
import reference from './reference.json';
import { loadHierarchy, selectCopcNodes, mapPool } from '../benchmark-common.mjs';

// Every source access copies its requested bytes, as a received Range body does.
// The full immutable file is shared across samples; reader caches are not.
export function memorySource(buffer) {
  const metrics = { bytesRead: 0, ranges: 0 };
  const getter = async (begin, end) => {
    metrics.bytesRead += end - begin;
    metrics.ranges += 1;
    return new Uint8Array(buffer.slice(begin, end));
  };
  const fetch = async (_url, init = {}) => {
    if (init.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': buffer.byteLength } });
    const match = new Headers(init.headers).get('Range')?.match(/^bytes=(\d+)-(\d*)$/);
    if (!match) throw new Error('Expected Range');
    const begin = Number(match[1]);
    const end = match[2] ? Number(match[2]) + 1 : buffer.byteLength;
    return new Response(await getter(begin, end), { status: 206,
      headers: { 'Content-Range': `bytes ${begin}-${end-1}/${buffer.byteLength}` } });
  };
  return { getter, fetch, metrics, byteLength: buffer.byteLength };
}

export async function runParquet(source, query) {
  const started = performance.now();
  const cloud = await PointCloudParquet.open('memory://cloud.parquet', { fetch: source.fetch, ...(source.byteLength ? { byteLength: source.byteLength } : {}) });
  const openElapsedMs = performance.now() - started;
  const result = await cloud.queryWorld(query.bounds, reference.lod.parquet.maxLevel);
  const loadElapsedMs = performance.now() - started;
  return { chunks: result.chunks, metadata: cloud.metadata, openElapsedMs, loadElapsedMs, pointsMatched: result.metrics.pointsMatched,
    bytesRead: source.metrics.bytesRead, ranges: source.metrics.ranges,
    outputBytes: result.chunks.reduce((n,c) => n + ['x','y','z','red','green','blue'].reduce((m,k)=>m+c[k].byteLength,0),0) };
}

export async function runCopc(source, query, decoders) {
  const started = performance.now();
  const cloud = await Copc.create(source.getter);
  const { nodes } = await loadHierarchy(source.getter, cloud.info.rootHierarchyPage);
  const openElapsedMs = performance.now() - started;
  const candidates = selectCopcNodes(cloud, nodes, query.bounds, reference.lod.copc.maxDepth);
  const chunks = [];
  await mapPool(candidates, decoders, async ([,node], lazPerf) => {
    const view = await Copc.loadPointDataView(source.getter, cloud, node, { lazPerf, include: ['X','Y','Z','Red','Green','Blue'] });
    const xyz = ['X','Y','Z'].map(k => view.getter(k));
    const rgb = ['Red','Green','Blue'].map(k => view.dimensions[k] ? view.getter(k) : () => 0);
    const columns = [new Int32Array(view.pointCount),new Int32Array(view.pointCount),new Int32Array(view.pointCount),
      new Uint16Array(view.pointCount),new Uint16Array(view.pointCount),new Uint16Array(view.pointCount)];
    let count = 0;
    for (let i = 0; i < view.pointCount; i++) {
      const x = xyz[0](i), y = xyz[1](i), z = xyz[2](i);
      const { min, max } = query.bounds;
      if (x<min[0]||x>max[0]||y<min[1]||y>max[1]||z<min[2]||z>max[2]) continue;
      columns[0][count] = Math.round((x-cloud.header.offset[0])/cloud.header.scale[0]);
      columns[1][count] = Math.round((y-cloud.header.offset[1])/cloud.header.scale[1]);
      columns[2][count] = Math.round((z-cloud.header.offset[2])/cloud.header.scale[2]);
      for (let axis=0;axis<3;axis++) columns[axis+3][count] = rgb[axis](i);
      count++;
    }
    chunks.push(columns.map(column=>column.slice(0,count)));
  });
  const loadElapsedMs = performance.now() - started;
  return { chunks: chunks.map(c => ({ x:c[0],y:c[1],z:c[2],red:c[3],green:c[4],blue:c[5],length:c[0].length,resolution:0 })),
    metadata: { scale: cloud.header.scale, offset: cloud.header.offset, bounds: [...cloud.header.min,...cloud.header.max] },
    openElapsedMs, loadElapsedMs, pointsMatched: chunks.reduce((n,c)=>n+c[0].length,0),
    bytesRead: source.metrics.bytesRead, ranges: source.metrics.ranges,
    outputBytes: chunks.reduce((n,c)=>n+c.reduce((m,col)=>m+col.byteLength,0),0) };
}
