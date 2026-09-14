const button = document.querySelector('#run');
let downloadUrl;
button.onclick = () => {
  button.disabled = true;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  document.querySelector('#download').hidden = true;
  document.querySelector('#result').value = '';
  document.querySelector('#summary').textContent = '';
  const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onerror = (event) => {
    document.querySelector('#status').textContent = `失敗: ${event.message}`;
    button.disabled = false;
    worker.terminate();
  };
  worker.onmessage = ({ data }) => {
    document.querySelector('#status').textContent = data.status;
    if (data.failed) {
      button.disabled = false;
      worker.terminate();
      return;
    }
    if (!data.result) return;
    const result = data.result;
    const json = JSON.stringify(result, null, 2);
    document.querySelector('#result').value = json;
    document.querySelector('#summary').textContent = result.queries.map(q =>
      `${q.name}: Parquet ${q.parquet.loadElapsedMs.toFixed(1)} ms / COPC ${q.copc.loadElapsedMs.toFixed(1)} ms`
    ).join('\n') + '\n合計: ' + ['parquet','copc'].map(f => `${f} ${result.queries.reduce((n,q) => n+q[f].loadElapsedMs,0).toFixed(1)} ms`).join(' / ');
    const link = document.querySelector('#download');
    downloadUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    link.href = downloadUrl;
    link.download = `copc-comparison-browser-memory-${result.measuredAt.slice(0,10).replaceAll('-','')}.json`;
    link.hidden = false;
    button.disabled = false;
    worker.terminate();
  };
  worker.postMessage({ userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency });
};
