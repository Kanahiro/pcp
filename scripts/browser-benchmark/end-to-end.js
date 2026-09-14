import * as THREE from 'three';
import { QuantizedPointMaterial } from '../../apps/viewer/src/point-material.ts';
import { aggregate } from '../benchmark-common.mjs';
import reference from '../../benchmarks/copc-comparison-load-20260914.json';

const frame = () => new Promise(resolve=>requestAnimationFrame(resolve));
const status = document.querySelector('#status');
const button = document.querySelector('#run');
let downloadUrl;

async function trial(format,url,query,expected,keepFrame) {
  if (document.visibilityState !== 'visible') throw new Error('測定タブを表示した状態で実行してください');
  let hidden = false;
  const visibility = () => { if (document.visibilityState !== 'visible') hidden = true; };
  document.addEventListener('visibilitychange',visibility);
  const start = performance.now();
  const worker = new Worker(new URL('./network.worker.js',import.meta.url),{type:'module'});
  let renderer;
  const geometries = [];
  let material;
  try {
    const loaded = new Promise((resolve,reject)=> {
      worker.onmessage = ({data})=>data.error?reject(new Error(data.error)):resolve(data);
      worker.onerror = event=>reject(new Error(event.message||'Worker failed'));
    });
    worker.postMessage({format,url,query});
    renderer = new THREE.WebGLRenderer({antialias:false,preserveDrawingBuffer:true});
    renderer.setPixelRatio(1);
    renderer.setSize(960,540);
    renderer.setClearColor(0x111315,1);
    document.querySelector('#viewport').replaceChildren(renderer.domElement);
    const { buffers,metadata,sample } = await loaded;
    const dataReadyMs = performance.now()-start;
    const origin = query.bounds.min.map((v,i)=>(v+query.bounds.max[i])/2);
    const extent = Math.max(...query.bounds.max.map((v,i)=>v-query.bounds.min[i]));
    const quantizedBounds = {
      min:metadata.bounds.slice(0,3).map((v,i)=>Math.floor((v-metadata.offset[i])/metadata.scale[i])),
      max:metadata.bounds.slice(3).map((v,i)=>Math.ceil((v-metadata.offset[i])/metadata.scale[i])),
    };
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50,960/540,.01,extent*20);
    camera.up.set(0,0,1);
    camera.position.set(extent*1.4,-extent*1.8,extent*1.2);
    camera.lookAt(0,0,0);
    material = new QuantizedPointMaterial(metadata,origin,quantizedBounds,1);
    material.viewportScale = 270;
    for (const buffer of buffers) {
      const geometry = new THREE.BufferGeometry();
      const position = new THREE.BufferAttribute(buffer.quantizedPositions,3);
      position.gpuType = THREE.IntType;
      geometry.setAttribute('position',position);
      geometry.setAttribute('color',new THREE.BufferAttribute(buffer.colors,3));
      const points = new THREE.Points(geometry,material);
      points.frustumCulled = false;
      scene.add(points);
      geometries.push(geometry);
    }
    await frame();
    const renderStart = performance.now();
    renderer.render(scene,camera);
    const gl = renderer.getContext();
    // render() merely submits commands. finish() waits for their GPU completion.
    // The following RAF is a presentation opportunity, not a scan-out timestamp.
    gl.finish();
    const gpuCompleteMs = performance.now()-start;
    const renderAndGpuMs = performance.now()-renderStart;
    await frame();
    const frameBoundaryMs = performance.now()-start;
    if (hidden) throw new Error('Tab became hidden during measurement');
    if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error');
    if (renderer.info.render.points !== expected || sample.pointsMatched !== expected) throw new Error('Rendered point count mismatch');
    const pixels = new Uint8Array(960*540*4);
    gl.readPixels(0,0,960,540,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    let changedPixels = 0;
    for (let i=4;i<pixels.length;i+=4) {
      if (pixels[i]!==pixels[0]||pixels[i+1]!==pixels[1]||pixels[i+2]!==pixels[2]) changedPixels++;
    }
    if (!changedPixels) throw new Error('Canvas has no visible point pixels');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { ...sample, dataReadyMs, gpuCompleteMs, frameBoundaryMs, renderAndGpuMs,
      renderedPoints:renderer.info.render.points,drawCalls:renderer.info.render.calls,changedPixels,
      gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),
    };
  } finally {
    worker.terminate();
    document.removeEventListener('visibilitychange',visibility);
    for (const geometry of geometries) geometry.dispose();
    material?.dispose();
    if (keepFrame && renderer) {
      const image = new Image();
      image.alt = `${format} 最終描画（計測後の保存画像）`;
      image.width = 960;
      image.height = 540;
      image.src = renderer.domElement.toDataURL();
      document.querySelector('#viewport').replaceChildren(image);
    }
    renderer?.dispose();
    renderer?.forceContextLoss();
  }
}

button.onclick = async () => {
  button.disabled = true;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  document.querySelector('#download').hidden = true;
  document.querySelector('#result').value = '';
  try {
    const urls = Object.fromEntries(['parquet','copc'].map(f=>[f,new URL(document.querySelector('#'+f).value,location.href).href]));
    const queries = [];
    for (const original of reference.queries) {
      const query = {bounds:{min:original.bounds.slice(0,3),max:original.bounds.slice(3)}};
      const samples = {parquet:[],copc:[]};
      for (let run=0;run<4;run++) {
        for (const format of run%2?['copc','parquet']:['parquet','copc']) {
          status.textContent = `${original.name}: ${format} ${run?`${run}/3`:'warmup'}`;
          const sample = await trial(format,urls[format],query,original[format].pointsMatched,original.name==='large'&&run===3&&format==='parquet');
          if (sample.bytesRead!==original[format].totalBytesFetched) throw new Error('Range byte count mismatch');
          if (run) samples[format].push(sample);
        }
      }
      queries.push({name:original.name,bounds:original.bounds,parquet:aggregate(samples.parquet),copc:aggregate(samples.copc),samples});
    }
    const delays = [...new Set(queries.flatMap(q=>['parquet','copc'].flatMap(f=>q.samples[f].map(s=>s.serverResponseDelayMs))))];
    if (delays.length !== 1) throw new Error('Server delay differs between samples');
    const serverResponseDelayMs = delays[0];
    const protocols = [...new Set(queries.flatMap(q=>['parquet','copc'].flatMap(f=>q.samples[f].flatMap(s=>s.resources.map(r=>r.nextHopProtocol)))))];
    const protocol = protocols.length === 1 && protocols[0] ? protocols[0] : null;
    const result = { benchmark:'browser-http-through-gpu-and-next-frame',measuredAt:new Date().toISOString(),
      environment:{protocol,protocolsObserved:protocols,protocolVerification:protocol ? 'Resource Timing' : 'Unavailable or mixed; cross-origin Timing-Allow-Origin may be absent',maxConcurrentStreams:queries[0].samples.parquet[0].maxConcurrentStreams,serverResponseDelayMs,userAgent:navigator.userAgent,hardwareConcurrency:navigator.hardwareConcurrency,
        repeats:3,warmup:1,canvas:[960,540],devicePixelRatio:1,pointSize:1,antialias:false,preserveDrawingBuffer:true,
        gpu:queries[0].samples.parquet[0].gpu,
        timing:'main-thread start before new Worker and WebGL context; includes worker/module initialization, decoder initialization, HEAD/metadata/Range fetch, decode, filtering, RGB conversion, transferable buffers, geometry/shader setup, GPU upload and draw; frameBoundaryMs ends at following RAF after gl.finish',
        cache:'point data fetch cache:no-store; worker/decoder instances new each trial; module/WASM HTTP caches, JIT, OS cache and connections not cleared',
        exclusions:'benchmark page initial download; browser compositor/physical display scan-out not observable; pixel verification after timer',
        rendering:'all chunks drawn together, common viewer buildPointBuffers and QuantizedPointMaterial; no progressive frames or screen-space mesh',
      },urls,dataset:reference.dataset,lod:reference.lod,queries};
    const json = JSON.stringify(result,null,2);
    document.querySelector('#result').value = json;
    document.querySelector('#summary').textContent = queries.map(q=>`${q.name}: ${q.parquet.frameBoundaryMs.toFixed(1)} / ${q.copc.frameBoundaryMs.toFixed(1)} ms`).join('\n')+
      '\n合計 Parquet / COPC: '+['parquet','copc'].map(f=>queries.reduce((n,q)=>n+q[f].frameBoundaryMs,0).toFixed(1)).join(' / ')+' ms';
    downloadUrl = URL.createObjectURL(new Blob([json],{type:'application/json'}));
    const link = document.querySelector('#download');
    link.href = downloadUrl;
    link.download = `copc-comparison-browser-e2e${Object.values(urls).some(url=>!['localhost','127.0.0.1'].includes(new URL(url).hostname))?'-remote':''}${protocol==='h2'?'-h2':''}${serverResponseDelayMs>0?`-delay${serverResponseDelayMs}`:''}-${result.measuredAt.slice(0,10).replaceAll('-','')}.json`;
    link.hidden = false;
    const saved = await fetch('/__save-browser-benchmark', { method:'POST', headers:{'Content-Type':'application/json'}, body:json });
    if (!saved.ok) throw new Error(`Result save failed: ${await saved.text()}`);
    link.href = await saved.text();
    status.textContent = '完了：全試行で描画点数・非背景ピクセル・取得量を検証済み。JSONをbenchmarksへ保存しました';
  } catch(error) { status.textContent = `失敗: ${error.stack??error}`; }
  finally { button.disabled = false; }
};
