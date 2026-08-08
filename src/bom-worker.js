// generateBOM() is CPU-heavy and fully synchronous (zlib inflate attempts at
// nearly every byte offset of every candidate blob, across every component
// file involved) — several seconds even for a small assembly. Running it
// directly in the Electron main process blocks its event loop for that
// whole time: no window repaints, no other IPC handled, the app reads as
// hung. This worker thread keeps that computation off the main process
// entirely so the UI stays responsive while it runs.
const { parentPort, workerData } = require('worker_threads');
const bom = require('./bom');

try {
  const { csv } = bom.generateBOM(workerData.assemblyPath, { levels: workerData.levels });
  parentPort.postMessage({ ok: true, csv });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}
