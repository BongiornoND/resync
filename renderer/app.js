import { createViewer } from '/renderer/viewer.js';

const hasApi = typeof window.api !== 'undefined';

// --- Shared preview panel: one viewer instance + several content modes
// (3D viewport, image, PDF, text, CSV table), only one visible at a time.
// Used both inline and, on click, fullscreen. ---

const previewRenderEl = document.getElementById('preview-render');
const previewViewportEl = document.getElementById('preview-viewport');
const previewImageEl = document.getElementById('preview-image');
const previewPdfContainerEl = document.getElementById('preview-pdf-container');
const previewTextEl = document.getElementById('preview-text');
const previewTableContainerEl = document.getElementById('preview-table-container');
const previewPlaceholderEl = document.getElementById('preview-placeholder');
const previewTypeBadgeEl = document.getElementById('preview-type-badge');
const previewTreeEl = document.getElementById('preview-assembly-tree');
const fullscreenCloseBtn = document.getElementById('preview-fullscreen-close');
const csvActionsEl = document.getElementById('preview-csv-actions');
const csvEditBtn = document.getElementById('csv-edit-btn');
const csvSaveBtn = document.getElementById('csv-save-btn');
const csvCancelBtn = document.getElementById('csv-cancel-btn');

const previewViewer = createViewer({
  container: previewViewportEl,
  treeContainer: previewTreeEl,
  messageEl: null,
});

let currentImageObjectUrl = null;

// Guards async preview loaders (PDF, 3D) against overlapping invocations —
// e.g. a file input firing 'change' more than once for one selection, or a
// user picking a second file before the first preview finishes loading.
// Without this, two concurrent pdf.js getDocument() calls race over the
// same transferable buffer and neither ever finishes rendering.
let previewGeneration = 0;

// CSV in-app editing state — csvEditRows is the source of truth (never
// mutated by typing, only by a successful Save), so Cancel can always
// discard live DOM edits by just re-rendering from it. csvEditFileId is
// only set when the current preview is a file's latest version (see
// dispatchPreview's editCtx) — editing a historical version doesn't make
// sense, since saving always adds a new version on top of the latest.
let csvEditRows = null;
let csvEditFileId = null;
let csvEditing = false;

function hideAllPreviewModes() {
  previewViewportEl.hidden = true;
  previewImageEl.hidden = true;
  previewPdfContainerEl.hidden = true;
  previewTextEl.hidden = true;
  previewTableContainerEl.hidden = true;
  if (currentImageObjectUrl) {
    URL.revokeObjectURL(currentImageObjectUrl);
    currentImageObjectUrl = null;
  }
  previewImageEl.src = '';
  previewPdfContainerEl.innerHTML = '';
  previewTextEl.textContent = '';
  previewTableContainerEl.innerHTML = '';
  csvActionsEl.hidden = true;
  csvEditBtn.hidden = false;
  csvSaveBtn.hidden = true;
  csvCancelBtn.hidden = true;
  csvEditRows = null;
  csvEditFileId = null;
  csvEditing = false;
}

function setPreviewStatus(text) {
  previewRenderEl.classList.remove('has-preview');
  previewTypeBadgeEl.hidden = true;
  previewPlaceholderEl.textContent = text;
}

function markPreviewReady(typeLabel) {
  previewRenderEl.classList.add('has-preview');
  previewTypeBadgeEl.textContent = typeLabel;
  previewTypeBadgeEl.hidden = false;
}

function clearPreview() {
  previewViewer.clear();
  hideAllPreviewModes();
  setPreviewStatus('Select a file to preview');
}

// --- Individual preview-mode loaders ---

function decodeTextBytes(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

const IMAGE_MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};
function mimeForImage(fileName) {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  return IMAGE_MIME_BY_EXT[ext] || 'application/octet-stream';
}

function previewImageBytes(bytes, fileName) {
  hideAllPreviewModes();
  const blob = new Blob([bytes], { type: mimeForImage(fileName) });
  currentImageObjectUrl = URL.createObjectURL(blob);
  previewImageEl.src = currentImageObjectUrl;
  previewImageEl.hidden = false;
  markPreviewReady('Image');
}

let pdfjsPromise = null;
function getPdfjs() {
  if (!pdfjsPromise) {
    // The "legacy" build, not the modern one: pdf.js's own code relies on
    // brand-new JS builtins (Uint8Array.prototype.toHex, Map.prototype.
    // getOrInsertComputed, ...) that this Electron's bundled Chromium
    // doesn't have yet — real-world PDFs hit these constantly (e.g. via
    // the document-fingerprint step, which reads the trailer's /ID entry
    // present in virtually every PDF). The legacy build self-polyfills
    // all of these at import time, in whichever realm imports it, so a
    // normal dedicated Worker is fine here.
    pdfjsPromise = import('/node_modules/pdfjs-dist/legacy/build/pdf.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs';
      return lib;
    });
  }
  return pdfjsPromise;
}

// Capped to the first 20 pages — this is a preview, not a document reader.
async function previewPdfBytes(bytes, fileName, gen) {
  hideAllPreviewModes();
  setPreviewStatus('Loading ' + fileName + '…');
  try {
    const pdfjsLib = await getPdfjs();
    if (gen !== previewGeneration) return;
    const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
    if (gen !== previewGeneration) return;
    const maxPages = Math.min(doc.numPages, 20);
    for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      if (gen !== previewGeneration) return;
      const viewport = page.getViewport({ scale: 1.4 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      // intent: 'print' keeps pdf.js's scheduler on plain promise microtasks
      // instead of requestAnimationFrame — this is a one-shot snapshot
      // render, not an interactive/animated view, so there's no reason to
      // gate it on paint timing (and rAF never fires for a backgrounded
      // preview panel in some hosts, which would hang the render forever).
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, intent: 'print' }).promise;
      if (gen !== previewGeneration) return;
      previewPdfContainerEl.appendChild(canvas);
    }
    previewPdfContainerEl.hidden = false;
    markPreviewReady('PDF');
  } catch (err) {
    if (gen !== previewGeneration) return;
    console.error(err);
    setPreviewStatus('Could not preview ' + fileName + ': ' + err.message);
  }
}

const MAX_TEXT_PREVIEW_CHARS = 200000;

function previewTextBytes(bytes, fileName, label) {
  hideAllPreviewModes();
  const text = decodeTextBytes(bytes);
  previewTextEl.textContent =
    text.length > MAX_TEXT_PREVIEW_CHARS ? text.slice(0, MAX_TEXT_PREVIEW_CHARS) + '\n\n… (truncated preview)' : text;
  previewTextEl.hidden = false;
  markPreviewReady(label);
}

// Minimal RFC 4180-ish CSV parser — handles quoted fields, escaped quotes,
// commas/newlines inside quotes. Not a full spec implementation, but
// covers what spreadsheet exports actually produce.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const MAX_CSV_PREVIEW_ROWS = 500;

// Detected purely by column shape (bom.py's own CSV header), not by
// filename — so a BOM keeps its special display no matter what it's
// named or renamed to.
const BOM_CSV_COLUMNS = ['qty', 'name', 'kind', 'part_number', 'description', 'material', 'file'];

function isBomCsv(rows) {
  if (!rows.length) return false;
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return BOM_CSV_COLUMNS.every((col) => header.includes(col));
}

function fileBaseName(p) {
  if (!p) return '';
  return p.split(/[\\/]/).pop();
}

// row/col refer to indexes into csvEditRows (the full, unfiltered parsed
// CSV, header included at index 0) — set on every editable cell so Save
// can read live DOM text back into the right place regardless of how few
// of the real columns this particular view actually displays.
function makeCell(text, rowIndex, colIndex) {
  const td = document.createElement('td');
  td.textContent = text;
  if (rowIndex != null && colIndex != null) {
    td.dataset.row = String(rowIndex);
    td.dataset.col = String(colIndex);
  }
  return td;
}

function previewBomTable(rows) {
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = Object.fromEntries(BOM_CSV_COLUMNS.map((c) => [c, header.indexOf(c)]));
  const body = rows.slice(1);

  const wrap = document.createElement('div');
  wrap.className = 'bom-preview';

  const totalInstances = body.reduce((sum, r) => sum + (parseInt(r[idx.qty], 10) || 0), 0);
  const missingCount = body.filter((r) => r[idx.kind] === 'missing').length;
  const summary = document.createElement('div');
  summary.className = 'bom-summary';
  summary.textContent =
    `${body.length} distinct part${body.length === 1 ? '' : 's'}, ${totalInstances} total instance${totalInstances === 1 ? '' : 's'}` +
    (missingCount ? `, ${missingCount} with no file found` : '');
  wrap.appendChild(summary);

  const table = document.createElement('table');
  table.className = 'bom-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  // Material isn't shown — Description is relabeled "Notes", both by
  // request; the underlying CSV column names are unchanged (bom.js still
  // writes description/material) so BOM detection stays keyed off the
  // real file shape, not this display choice.
  ['Qty', 'Part', 'Part Number', 'Notes', 'Source'].forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  body.forEach((r, i) => {
    const missing = r[idx.kind] === 'missing';
    const tr = document.createElement('tr');
    if (missing) tr.classList.add('bom-row-missing');
    const rowIndex = i + 1; // +1 for the header occupying row 0
    // Source is derived from the file path bom.py resolved — not
    // editable, so it gets no row/col and Save never touches it.
    tr.appendChild(makeCell(r[idx.qty] || '0', rowIndex, idx.qty));
    tr.appendChild(makeCell(r[idx.name] || '', rowIndex, idx.name));
    tr.appendChild(makeCell(r[idx.part_number] || '', rowIndex, idx.part_number));
    tr.appendChild(makeCell(r[idx.description] || '', rowIndex, idx.description));
    tr.appendChild(makeCell(missing ? 'Missing' : fileBaseName(r[idx.file]), null, null));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  previewTableContainerEl.appendChild(wrap);
  previewTableContainerEl.hidden = false;
}

function previewGenericCsvTable(rows) {
  const shown = rows.slice(0, MAX_CSV_PREVIEW_ROWS);

  const table = document.createElement('table');
  if (shown.length) {
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    shown[0].forEach((cell) => {
      const th = document.createElement('th');
      th.textContent = cell;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    shown.slice(1).forEach((r, i) => {
      const tr = document.createElement('tr');
      r.forEach((cell, c) => tr.appendChild(makeCell(cell, i + 1, c)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }
  previewTableContainerEl.appendChild(table);

  if (rows.length > MAX_CSV_PREVIEW_ROWS) {
    const note = document.createElement('div');
    note.className = 'muted small';
    note.style.padding = '8px';
    note.textContent = `Showing first ${MAX_CSV_PREVIEW_ROWS} of ${rows.length} rows — editing isn't available past this cutoff.`;
    previewTableContainerEl.appendChild(note);
  }
}

// Rebuilds the table(s) from a rows snapshot without touching the source
// bytes — used for the initial render and, since it never mutates `rows`
// itself, to discard in-progress edits on Cancel by simply re-rendering.
function renderCsvPreview(rows) {
  previewTableContainerEl.innerHTML = '';
  if (isBomCsv(rows)) {
    previewBomTable(rows);
    markPreviewReady('Bill of Materials');
  } else {
    previewGenericCsvTable(rows);
    markPreviewReady('CSV');
  }
}

function setCsvCellsEditable(editable) {
  previewTableContainerEl.querySelectorAll('td[data-row]').forEach((td) => {
    td.contentEditable = editable ? 'true' : 'false';
    td.classList.toggle('csv-cell-editable', editable);
  });
}

function enterCsvEditMode() {
  csvEditing = true;
  csvEditBtn.hidden = true;
  csvSaveBtn.hidden = false;
  csvCancelBtn.hidden = false;
  setCsvCellsEditable(true);
  const first = previewTableContainerEl.querySelector('td[data-row]');
  if (first) first.focus();
}

function exitCsvEditMode() {
  csvEditing = false;
  csvEditBtn.hidden = false;
  csvSaveBtn.hidden = true;
  csvCancelBtn.hidden = true;
  setCsvCellsEditable(false);
}

// Guards navigation away from an in-progress edit (selecting a different
// file, or a different version of this one) — called before any action
// that's about to replace the preview out from under unsaved edits.
function confirmDiscardCsvEdits() {
  if (!csvEditing) return true;
  if (!confirm('Discard unsaved edits to this file?')) return false;
  exitCsvEditMode();
  return true;
}

csvEditBtn.addEventListener('click', enterCsvEditMode);

csvCancelBtn.addEventListener('click', () => {
  exitCsvEditMode();
  renderCsvPreview(csvEditRows);
});

csvSaveBtn.addEventListener('click', async () => {
  previewTableContainerEl.querySelectorAll('td[data-row]').forEach((td) => {
    csvEditRows[Number(td.dataset.row)][Number(td.dataset.col)] = td.textContent;
  });
  const csvText = serializeCsv(csvEditRows);
  csvSaveBtn.disabled = true;
  csvSaveBtn.textContent = 'Saving…';
  const res = await window.api.server.saveCsvEdits(csvEditFileId, csvText);
  csvSaveBtn.disabled = false;
  csvSaveBtn.textContent = 'Save';
  if (!res.ok) {
    alert('Could not save: ' + res.error);
    return;
  }
  exitCsvEditMode();
  renderCsvPreview(csvEditRows);
  if (currentFolderId) loadFolder(currentFolderId);
});

function csvField(val) {
  const s = val == null ? '' : String(val);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function serializeCsv(rows) {
  return '﻿' + rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

function previewCsvBytes(bytes, fileName, editCtx) {
  hideAllPreviewModes();
  csvEditRows = parseCsv(decodeTextBytes(bytes));
  csvEditFileId = editCtx ? editCtx.fileId : null;
  csvActionsEl.hidden = !csvEditFileId;
  renderCsvPreview(csvEditRows);
}

async function preview3D(kind, bytes, fileName, gen) {
  hideAllPreviewModes();
  previewViewportEl.hidden = false;
  setPreviewStatus('Loading ' + fileName + '…');
  try {
    if (kind === 'step') await previewViewer.loadStep(bytes, fileName);
    else if (kind === 'iges') await previewViewer.loadIges(bytes, fileName);
    else if (kind === 'brep') await previewViewer.loadBrep(bytes, fileName);
    else if (kind === 'stl') await previewViewer.loadStl(bytes, fileName);
    else if (kind === 'obj') await previewViewer.loadObj(decodeTextBytes(bytes), fileName);
    else if (kind === 'gltf') {
      await previewViewer.loadGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), fileName);
    } else if (kind === 'sldprt') {
      const mesh = await window.api.sldprt.decodeBuffer(bytes);
      if (!mesh.ok) throw new Error(mesh.error);
      await previewViewer.loadMesh(mesh, fileName);
    }
    if (gen !== previewGeneration) return;
    markPreviewReady('3D Model');
  } catch (err) {
    if (gen !== previewGeneration) return;
    console.error(err);
    setPreviewStatus('Could not preview ' + fileName + ': ' + err.message);
  }
}

// Single dispatch point from a classify() result to the right loader —
// used both for server-downloaded files and local test files. Mints a
// generation token so a stale/duplicate invocation (e.g. an input firing
// 'change' twice, or picking a new file before the previous preview
// finished loading) can't clobber a newer one or leave two async loaders
// racing over the same resources.
async function dispatchPreview(c, bytes, fileName, editCtx) {
  const gen = ++previewGeneration;
  switch (c.previewKind) {
    case 'step':
    case 'iges':
    case 'brep':
    case 'stl':
    case 'obj':
    case 'gltf':
    case 'sldprt':
      await preview3D(c.previewKind, bytes, fileName, gen);
      break;
    case 'image':
      previewImageBytes(bytes, fileName);
      break;
    case 'pdf':
      await previewPdfBytes(bytes, fileName, gen);
      break;
    case 'csv':
      previewCsvBytes(bytes, fileName, editCtx);
      break;
    case 'text':
      previewTextBytes(bytes, fileName, c.type);
      break;
    default:
      clearPreview();
  }
}

// --- Fullscreen toggle (same viewer instance/container — its existing
// ResizeObserver in viewer.js picks up the size change automatically for
// the 3D mode; other modes just reflow via CSS, no JS needed) ---

function setFullscreen(on) {
  previewRenderEl.classList.toggle('fullscreen', on);
  previewTreeEl.classList.toggle('fullscreen-visible', on);
  fullscreenCloseBtn.hidden = !on;
  previewViewer.resize();
}

previewRenderEl.addEventListener('dblclick', () => {
  if (!previewRenderEl.classList.contains('has-preview')) return;
  setFullscreen(!previewRenderEl.classList.contains('fullscreen'));
});
fullscreenCloseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setFullscreen(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && previewRenderEl.classList.contains('fullscreen')) setFullscreen(false);
});

// --- File classification: which preview loader (if any) each extension
// routes to, plus which icon (see FILE_ICON_TABLE below) represents it ---

const STEP_EXT = /\.(step|stp)$/i;
const IGES_EXT = /\.(iges|igs)$/i;
const BREP_EXT = /\.brep$/i;
const STL_EXT = /\.stl$/i;
const OBJ_EXT = /\.obj$/i;
const GLTF_EXT = /\.(gltf|glb)$/i;
const SLDPRT_EXT = /\.sldprt$/i;
const SLDASM_EXT = /\.sldasm$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const PDF_EXT = /\.pdf$/i;
const CSV_EXT = /\.csv$/i;
const CODE_EXT = /\.(py|js|ts|json|ya?ml|xml|c|cpp|h|java|go|rs|sh)$/i;
const TEXT_EXT = /\.(txt|md|log)$/i;

// --- File-type icon set (imported from the "File type icon set" Claude
// Design project) — one glyph shape per file family, each extension mapped
// to a specific fill color + glyph color + glyph. Glyph markup is the exact
// inner SVG content from that project's icon components (viewBox 0 0 24 24,
// meant to sit inside an outer <svg fill="none" style="color:GLYPH_COLOR">). ---

const FILE_ICON_GLYPHS = {
  page: '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="currentColor" opacity="0.18"/><path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="2.3"/><path d="M14 3v4h4" stroke="currentColor" stroke-width="2.3"/><line x1="8" y1="12.5" x2="16" y2="12.5" stroke="currentColor" stroke-width="2.2"/><line x1="8" y1="15.5" x2="16" y2="15.5" stroke="currentColor" stroke-width="2.2"/><line x1="8" y1="18.5" x2="13" y2="18.5" stroke="currentColor" stroke-width="2.2"/>',
  book: '<path d="M4 5c2-1 5-1 7 1v13c-2-2-5-2-7-1z" fill="currentColor"/><path d="M20 5c-2-1-5-1-7 1v13c2-2 5-2 7-1z" fill="currentColor" opacity="0.6"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="1.5" stroke="currentColor" stroke-width="2.3"/><line x1="4" y1="10" x2="20" y2="10" stroke="currentColor" stroke-width="2.2"/><line x1="4" y1="15" x2="20" y2="15" stroke="currentColor" stroke-width="2.2"/><line x1="10" y1="4" x2="10" y2="20" stroke="currentColor" stroke-width="2.2"/><line x1="15" y1="4" x2="15" y2="20" stroke="currentColor" stroke-width="2.2"/>',
  slide: '<rect x="3" y="5" width="18" height="13" rx="1.5" stroke="currentColor" stroke-width="2.3"/><rect x="6" y="12" width="2.4" height="4" fill="currentColor"/><rect x="10.6" y="9" width="2.4" height="7" fill="currentColor"/><rect x="15.1" y="11" width="2.4" height="5" fill="currentColor"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="1.5" stroke="currentColor" stroke-width="2.3"/><circle cx="8.3" cy="9" r="1.7" fill="currentColor"/><path d="M4 17l5-5 3 3 4-5 5 6" stroke="currentColor" stroke-width="2.3" stroke-linejoin="round" stroke-linecap="round"/>',
  audio: '<circle cx="7" cy="18" r="2.4" fill="currentColor"/><circle cx="16" cy="16" r="2.4" fill="currentColor"/><path d="M9.4 18V6l8.6-1.8v12" stroke="currentColor" stroke-width="2.3"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" stroke-width="2.3"/><path d="M10 9.3l6 2.7-6 2.7z" fill="currentColor"/>',
  archive: '<rect x="4" y="5" width="16" height="15" rx="1.5" stroke="currentColor" stroke-width="2.3"/><line x1="12" y1="5" x2="12" y2="20" stroke="currentColor" stroke-width="2.2" stroke-dasharray="2,2"/><rect x="10" y="5" width="4" height="3" fill="currentColor"/>',
  disk: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.3"/><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2.3"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  code: '<path d="M9 5L4 12l5 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M15 5l5 7-5 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  font: '<text x="12" y="17.5" font-size="17" font-weight="800" text-anchor="middle" fill="currentColor" font-family="Georgia, serif">A</text><line x1="6" y1="19" x2="18" y2="19" stroke="currentColor" stroke-width="2.2"/>',
  database: '<ellipse cx="12" cy="6" rx="7" ry="2.3" stroke="currentColor" stroke-width="2.3"/><path d="M5 6v12c0 1.3 3.1 2.3 7 2.3s7-1 7-2.3V6" stroke="currentColor" stroke-width="2.3"/><path d="M5 12c0 1.3 3.1 2.3 7 2.3s7-1 7-2.3" stroke="currentColor" stroke-width="2.3"/>',
  folder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" fill="currentColor"/>',
  gear: '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2.3"/><path d="M12 3v2.5M12 18.5V21M21 12h-2.5M5.5 12H3M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8M18.4 18.4l-1.8-1.8M7.4 7.4L5.6 5.6" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>',
  cube: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" stroke="currentColor" stroke-width="2.3" stroke-linejoin="round"/><path d="M12 3v9M4 7.5l8 4.5 8-4.5" stroke="currentColor" stroke-width="2.3" stroke-linejoin="round"/><path d="M12 12v9" stroke="currentColor" stroke-width="2.3"/>',
  blueprint: '<rect x="3.5" y="3.5" width="17" height="17" rx="1.5" stroke="currentColor" stroke-width="2.3"/><path d="M8 8v8M8 8h5.5a2.5 2.5 0 0 1 0 5H8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><line x1="6" y1="5.8" x2="6" y2="4.2" stroke="currentColor" stroke-width="1.6"/><line x1="18" y1="19.8" x2="18" y2="18.2" stroke="currentColor" stroke-width="1.6"/>',
};

const W = '#FFFFFF', D = '#1F2430';
// [ext, name, fill color, glyph color, glyph] — extensions as given by the
// design project, keyed uppercase without the dot.
const FILE_ICON_RAW = [
  ['PDF', 'PDF Document', '#E5493A', W, 'page'],
  ['DOC', 'Word Document', '#2B579A', W, 'page'],
  ['RTF', 'Rich Text', '#5C7CB5', W, 'page'],
  ['TXT', 'Plain Text', '#6B7280', W, 'page'],
  ['MD', 'Markdown', '#374151', W, 'page'],
  ['LOG', 'Log File', '#95A5A6', W, 'page'],
  ['EPUB', 'eBook', '#7C5A9E', W, 'book'],
  ['XLS', 'Spreadsheet', '#1D6F42', W, 'grid'],
  ['CSV', 'CSV Data', '#16847A', W, 'grid'],
  ['PPT', 'Presentation', '#D24726', W, 'slide'],
  ['KEY', 'Keynote', '#0071E3', W, 'slide'],
  ['JPG', 'JPEG Image', '#8E44AD', W, 'image'],
  ['PNG', 'PNG Image', '#9B59B6', W, 'image'],
  ['GIF', 'GIF Image', '#D6408C', W, 'image'],
  ['SVG', 'Vector Image', '#FF9900', W, 'image'],
  ['PSD', 'Photoshop', '#2996FC', W, 'image'],
  ['AI', 'Illustrator', '#FF9A00', W, 'image'],
  ['MP3', 'Audio', '#F2994A', W, 'audio'],
  ['WAV', 'Audio', '#F2C94C', D, 'audio'],
  ['MP4', 'Video', '#E84393', W, 'video'],
  ['MOV', 'Video', '#6C5CE7', W, 'video'],
  ['ZIP', 'Archive', '#C99A3E', W, 'archive'],
  ['RAR', 'Archive', '#8D6E63', W, 'archive'],
  ['ISO', 'Disk Image', '#607D8B', W, 'disk'],
  ['DMG', 'Disk Image', '#7F8C8D', W, 'disk'],
  ['HTML', 'HTML File', '#E34C26', W, 'code'],
  ['CSS', 'Stylesheet', '#1572B6', W, 'code'],
  ['JS', 'JavaScript', '#E8C547', D, 'code'],
  ['JSON', 'JSON Data', '#4B5563', W, 'code'],
  ['PY', 'Python', '#3776AB', W, 'code'],
  ['JAVA', 'Java', '#E76F00', W, 'code'],
  ['PHP', 'PHP', '#777BB4', W, 'code'],
  ['XML', 'XML Data', '#E67E22', W, 'code'],
  ['YAML', 'YAML Config', '#CB171E', W, 'code'],
  ['TTF', 'Font File', '#2C3E50', W, 'font'],
  ['SQL', 'SQL Database', '#336791', W, 'database'],
  ['DB', 'Database', '#16A085', W, 'database'],
  ['FOLDER', 'Folder', '#5B9BD5', W, 'folder'],
  ['EXE', 'Application', '#555555', W, 'gear'],
  ['APP', 'Application', '#34495E', W, 'gear'],
  ['STL', '3D Print Model', '#546E7A', W, 'cube'],
  ['OBJ', '3D Model', '#37474F', W, 'cube'],
  ['FBX', '3D Model', '#00599C', W, 'cube'],
  ['GLTF', '3D Model', '#1E88E5', W, 'cube'],
  ['STEP', 'CAD Model', '#78909C', W, 'blueprint'],
  ['IGES', 'CAD Model', '#90A4AE', W, 'blueprint'],
  ['DWG', 'AutoCAD Drawing', '#C0392B', W, 'blueprint'],
  ['DXF', 'CAD Drawing', '#D35400', W, 'blueprint'],
  ['SLDPRT', 'SolidWorks Part', '#D0332E', W, 'cube'],
  ['SLDASM', 'SolidWorks Assembly', '#B71C1C', W, 'cube'],
  ['SLDDRW', 'SolidWorks Drawing', '#922B21', W, 'blueprint'],
  // Not in the source icon set — extensions this app already recognizes,
  // mapped onto the closest matching glyph/color family above.
  ['BREP', 'CAD Model', '#78909C', W, 'blueprint'],
  ['BMP', 'Bitmap Image', '#9B59B6', W, 'image'],
  ['WEBP', 'WebP Image', '#9B59B6', W, 'image'],
  ['TS', 'TypeScript', '#4B5563', W, 'code'],
  ['GO', 'Go', '#4B5563', W, 'code'],
  ['RS', 'Rust', '#4B5563', W, 'code'],
  ['C', 'C Source', '#4B5563', W, 'code'],
  ['CPP', 'C++ Source', '#4B5563', W, 'code'],
  ['H', 'Header File', '#4B5563', W, 'code'],
  ['SH', 'Shell Script', '#4B5563', W, 'code'],
];
const FILE_ICON_ALIASES = {
  JPEG: 'JPG', STP: 'STEP', IGS: 'IGES', GLB: 'GLTF', YML: 'YAML', HTM: 'HTML',
};
const FILE_ICON_TABLE = Object.fromEntries(
  FILE_ICON_RAW.map(([ext, name, color, glyphColor, glyph]) => [ext, { name, color, glyphColor, glyph }])
);
const FILE_ICON_UNKNOWN = { name: 'File', color: '#9CA3AF', glyphColor: '#FFFFFF', glyph: 'page' };

function fileIconOf(ext) {
  const key = FILE_ICON_ALIASES[ext] || ext;
  return FILE_ICON_TABLE[key] || FILE_ICON_UNKNOWN;
}

function fileIconSvg(glyph, glyphColor, size = 18) {
  const inner = FILE_ICON_GLYPHS[glyph] || FILE_ICON_GLYPHS.page;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" style="color:${glyphColor}">${inner}</svg>`;
}

function classify(file) {
  if (file.isFolder) {
    const icon = FILE_ICON_TABLE.FOLDER;
    return { glyph: icon.glyph, bg: icon.color, fg: icon.glyphColor, badge: '', type: 'Folder', previewKind: null };
  }
  const name = file.name;
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toUpperCase();
  const icon = fileIconOf(ext);
  const iconProps = { glyph: icon.glyph, bg: icon.color, fg: icon.glyphColor, badge: ext };

  if (STEP_EXT.test(name)) return { ...iconProps, type: '3D Model', previewKind: 'step' };
  if (IGES_EXT.test(name)) return { ...iconProps, type: '3D Model', previewKind: 'iges' };
  if (BREP_EXT.test(name)) return { ...iconProps, type: '3D Model', previewKind: 'brep' };
  if (STL_EXT.test(name)) return { ...iconProps, type: '3D Model', previewKind: 'stl' };
  if (OBJ_EXT.test(name)) return { ...iconProps, type: '3D Model', previewKind: 'obj' };
  if (GLTF_EXT.test(name)) return { ...iconProps, type: '3D Model', previewKind: 'gltf' };
  if (SLDPRT_EXT.test(name)) return { ...iconProps, type: '3D Model', previewKind: 'sldprt' };
  // .sldasm: recognized and badged, but no preview yet — assembly reference
  // graphs are a much harder problem than any single-file format above.
  if (SLDASM_EXT.test(name)) return { ...iconProps, type: '3D Model', previewKind: null };

  if (PDF_EXT.test(name)) return { ...iconProps, type: 'PDF', previewKind: 'pdf' };
  if (IMG_EXT.test(name)) return { ...iconProps, type: 'Image', previewKind: 'image' };
  if (CSV_EXT.test(name)) return { ...iconProps, type: 'CSV', previewKind: 'csv' };
  if (CODE_EXT.test(name)) return { ...iconProps, type: 'Code', previewKind: 'text' };
  if (TEXT_EXT.test(name)) return { ...iconProps, type: 'Text', previewKind: 'text' };

  return { ...iconProps, type: 'File', previewKind: null };
}

function formatSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
}

// The server returns SQLite's "YYYY-MM-DD HH:MM:SS" (UTC, no offset) —
// normalize to real ISO so Date parses it as UTC, not local time.
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const iso = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  const iso = dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function initialsOf(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase() || name[0].toUpperCase();
}

// Every file/folder/project name and every member's display name/email is
// arbitrary user input (renamed, shared, or set via a Google profile) that
// ends up interpolated into innerHTML all over this file. Escaping it here
// once, and applying it at every interpolation site, is what stands between
// "rename a file to <img src=x onerror=...>" and it actually running in
// every other project member's renderer.
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Tag colors are arbitrary (user-picked via <input type="color">), so fixed
// white chip text goes illegible on light picks — WCAG relative-luminance
// threshold picks readable text either direction instead.
function contrastTextColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1c2223' : '#ffffff';
}

// --- Text-input prompt modal — Electron's BrowserWindow doesn't implement
// window.prompt() (it returns null immediately with no dialog shown at
// all), so every "ask for a name" flow uses this instead. ---

const inputModalOverlay = document.getElementById('input-modal-overlay');
const inputModalTitleEl = document.getElementById('input-modal-title');
const inputModalForm = document.getElementById('input-modal-form');
const inputModalInput = document.getElementById('input-modal-input');
const inputModalCancelBtn = document.getElementById('input-modal-cancel-btn');

function showInputModal(title, defaultValue = '') {
  return new Promise((resolve) => {
    inputModalTitleEl.textContent = title;
    inputModalInput.value = defaultValue;
    inputModalOverlay.hidden = false;
    inputModalInput.focus();
    inputModalInput.select();

    function finish(value) {
      inputModalOverlay.hidden = true;
      inputModalForm.removeEventListener('submit', onSubmit);
      inputModalCancelBtn.removeEventListener('click', onCancel);
      inputModalOverlay.removeEventListener('click', onBackdropClick);
      document.removeEventListener('keydown', onKeydown);
      resolve(value);
    }
    function onSubmit(e) {
      e.preventDefault();
      const value = inputModalInput.value.trim();
      finish(value || null);
    }
    function onCancel() {
      finish(null);
    }
    function onBackdropClick(e) {
      if (e.target === inputModalOverlay) finish(null);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') finish(null);
    }
    inputModalForm.addEventListener('submit', onSubmit);
    inputModalCancelBtn.addEventListener('click', onCancel);
    inputModalOverlay.addEventListener('click', onBackdropClick);
    document.addEventListener('keydown', onKeydown);
  });
}

// --- Screen switching (Projects / Browser tabs) ---

const tabs = document.querySelectorAll('.tab');
const screens = {
  projects: document.getElementById('screen-projects'),
  browser: document.getElementById('screen-browser'),
};

function switchScreen(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  tabs.forEach((t) => t.classList.toggle('active', t.dataset.screen === name));
  // ResizeObserver doesn't reliably fire when a container goes from
  // display:none to visible, so the preview viewer (created while this
  // screen was still hidden) needs an explicit nudge here.
  if (name === 'browser') previewViewer.resize();
}

tabs.forEach((t) => t.addEventListener('click', () => switchScreen(t.dataset.screen)));

// --- Projects screen: real projects, genuinely owned by this server ---

const projectsGridEl = document.getElementById('projects-grid');

function renderAddProjectCard() {
  const card = document.createElement('div');
  card.className = 'project-card add-card';
  card.innerHTML = `<div style="text-align:center">
    <div class="add-card-icon">+</div>
    <div class="add-card-label">New Project</div>
  </div>`;
  card.addEventListener('click', async () => {
    const name = await showInputModal('Project name');
    if (!name) return;
    const res = await window.api.server.createProject(name);
    if (!res.ok) {
      alert('Could not create project: ' + res.error);
      return;
    }
    loadProjects();
  });
  return card;
}

function renderProjectCard(p) {
  const card = document.createElement('div');
  card.className = 'project-card';
  card.addEventListener('click', () => openProject(p));

  const scrim = document.createElement('div');
  scrim.className = 'scrim';

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const coverBtn = document.createElement('button');
  coverBtn.className = 'card-icon-btn';
  coverBtn.title = 'Set cover image';
  coverBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>';
  coverBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const res = await window.api.server.uploadProjectCover(p.id);
    if (res.canceled) return;
    if (!res.ok) {
      alert('Could not set cover image: ' + res.error);
      return;
    }
    loadProjects();
  });
  actions.appendChild(coverBtn);

  if (p.role === 'owner' || p.role === 'admin') {
    const shareBtn = document.createElement('button');
    shareBtn.className = 'card-icon-btn';
    shareBtn.title = 'Manage access';
    shareBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-3.9M8.6 13.5l6.8 3.9"/></svg>';
    shareBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMembersModal(p.id);
    });
    actions.appendChild(shareBtn);
  }

  const syncBtn = document.createElement('button');
  syncBtn.className = 'card-icon-btn';
  syncBtn.title = 'Sync a local copy to this PC';
  syncBtn.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  syncBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    syncBtn.disabled = true;
    let syncFolder = (await window.api.settings.getSyncFolder()).syncFolder;
    if (!syncFolder) {
      const chosen = await window.api.settings.chooseSyncFolder();
      if (chosen.canceled) {
        syncBtn.disabled = false;
        return;
      }
      if (!chosen.ok) {
        alert('Could not set a sync folder: ' + chosen.error);
        syncBtn.disabled = false;
        return;
      }
      syncFolder = chosen.syncFolder;
    }
    const res = await window.api.server.syncProjectToLocal(p.id, p.name, p.rootFolderId);
    syncBtn.disabled = false;
    if (!res.ok) {
      alert('Sync failed: ' + res.error);
      return;
    }
    const notice = res.firstSync
      ? `\n\nThis folder now syncs continuously: local edits push up automatically (protected by check-out where this project requires it), and you'll get a badge here when there are remote changes to pull — pulling itself is always manual.`
      : '';
    alert(`Synced ${res.fileCount} file${res.fileCount === 1 ? '' : 's'} to:\n${res.localPath}${notice}`);
  });
  actions.appendChild(syncBtn);

  // Owner-only, not admin — this permanently deletes every file, version,
  // and share on the project with no trash/undo, so it's a step above
  // what a project admin can otherwise do. Confirmed by typing the project
  // name back (a plain confirm() is too easy to reflexively click through
  // for something this irreversible).
  if (p.isOwner) {
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'card-icon-btn danger';
    deleteBtn.title = 'Delete project';
    deleteBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const typed = await showInputModal(
        `This permanently deletes "${p.name}" — every file, version, and share. This cannot be undone.\n\nType the project name to confirm:`
      );
      if (typed === null) return;
      if (typed !== p.name) {
        alert('Name did not match — project was not deleted.');
        return;
      }
      deleteBtn.disabled = true;
      const res = await window.api.server.deleteProject(p.id);
      if (!res.ok) {
        alert('Could not delete project: ' + res.error);
        deleteBtn.disabled = false;
        return;
      }
      loadProjects();
    });
    actions.appendChild(deleteBtn);
  }

  const body = document.createElement('div');
  body.className = 'card-body';
  body.innerHTML = `
    <div>
      <div class="card-name">${escapeHtml(p.name)}</div>
      <div class="card-updated">Created ${formatDate(p.createdAt)}${p.isOwner ? '' : ' · shared with you'}</div>
    </div>`;

  card.append(scrim, actions, body);

  // The API is bearer-token authenticated, so a plain <img src> or CSS
  // background-image can't carry the Authorization header — fetch the
  // bytes over IPC instead and turn them into a blob: URL.
  if (p.hasCover) {
    window.api.server.downloadProjectCover(p.id).then((res) => {
      if (!res.ok) return;
      const blob = new Blob([new Uint8Array(res.data)]);
      card.style.backgroundImage = `url(${URL.createObjectURL(blob)})`;
      card.style.backgroundSize = 'cover';
      card.style.backgroundPosition = 'center';
    });
  }

  return card;
}

async function loadProjects() {
  if (!hasApi || !signedIn) {
    projectsGridEl.innerHTML = '<div class="muted">Sign in to see your projects.</div>';
    return;
  }
  const res = await window.api.server.listProjects();
  if (!res.ok) {
    projectsGridEl.innerHTML = `<div class="muted">Error: ${escapeHtml(res.error)}</div>`;
    return;
  }

  projectsGridEl.innerHTML = '';
  projectsGridEl.appendChild(renderAddProjectCard());
  for (const p of res.projects) {
    projectsGridEl.appendChild(renderProjectCard(p));
  }

  projectsSubtitleEl.textContent = `Signed in as ${lastProfile?.email || 'unknown'} · ${res.projects.length} projects`;
}

// --- Browser screen: real server data ---

const treeEl = document.getElementById('folder-tree');
const breadcrumbsEl = document.getElementById('breadcrumbs');
const fileTableBodyEl = document.getElementById('file-table-body');
const fileDetailsEl = document.getElementById('file-details');
const newFolderBtn = document.getElementById('new-folder-btn');
const uploadFileBtn = document.getElementById('upload-file-btn');
const shareProjectBtn = document.getElementById('share-project-btn');

// --- Upload queue — the picker/drop targets push file paths in here and
// keep accepting more immediately; a single worker below drains them one
// at a time so the server only ever sees one upload in flight, without the
// toolbar button locking up (or looking hung with zero feedback) for
// however long the whole batch takes. ---

const uploadQueueWrap = document.getElementById('upload-queue-wrap');
const uploadQueueBtn = document.getElementById('upload-queue-btn');
const uploadQueueBadge = document.getElementById('upload-queue-badge');
const uploadQueuePanel = document.getElementById('upload-queue-panel');
const uploadQueueListEl = document.getElementById('upload-queue-list');

let uploadQueue = [];
let uploadQueueRunning = false;
let uploadQueueSeq = 0;

function fileNameFromPath(filePath) {
  return filePath.split(/[\\/]/).pop();
}

const UPLOAD_STATUS_LABEL = { pending: 'Waiting…', uploading: 'Uploading…', done: 'Done' };

function renderUploadQueue() {
  const activeCount = uploadQueue.filter((item) => item.status === 'pending' || item.status === 'uploading').length;
  uploadQueueBtn.hidden = uploadQueue.length === 0;
  uploadQueueBadge.textContent = String(activeCount);

  uploadQueueListEl.innerHTML =
    uploadQueue
      .map((item) => {
        const label = item.status === 'error' ? `Failed: ${escapeHtml(item.error || 'unknown error')}` : UPLOAD_STATUS_LABEL[item.status];
        return `
    <div class="upload-queue-row">
      <div class="upload-queue-name">${escapeHtml(item.name)}</div>
      <div class="upload-queue-status ${item.status}">${label}</div>
    </div>`;
      })
      .join('') || '<div class="muted small" style="padding:14px">Nothing queued.</div>';
}

// Strictly one at a time — that's the point, both so the server only ever
// handles one upload from this client at once and so "uploaded one by one
// as each finishes" is literally true rather than an illusion over
// concurrent requests.
async function processUploadQueue() {
  if (uploadQueueRunning) return;
  uploadQueueRunning = true;
  try {
    let item;
    while ((item = uploadQueue.find((i) => i.status === 'pending'))) {
      item.status = 'uploading';
      renderUploadQueue();

      const res = await window.api.server.uploadFilePath(item.folderId, item.filePath);
      if (res.ok) {
        item.status = 'done';
      } else {
        item.status = 'error';
        item.error = res.error;
      }
      renderUploadQueue();

      if (item.folderId === currentFolderId) await loadFolder(currentFolderId);
    }
  } finally {
    uploadQueueRunning = false;
    // Leave finished rows visible for a moment instead of yanking them away
    // the instant they land — still clears itself out so the panel doesn't
    // just accumulate every upload from the whole session.
    setTimeout(() => {
      uploadQueue = uploadQueue.filter((i) => i.status === 'pending' || i.status === 'uploading');
      renderUploadQueue();
    }, 4000);
  }
}

function enqueueUploads(folderId, filePaths) {
  for (const filePath of filePaths) {
    uploadQueue.push({ id: ++uploadQueueSeq, folderId, filePath, name: fileNameFromPath(filePath), status: 'pending' });
  }
  renderUploadQueue();
  processUploadQueue();
}

let selectedFileId = null;
let currentProjectId = null;
let currentFolderId = null;
let currentSyncMode = 'checkin';

// --- Local sync status — per-project continuous sync (push automatic,
// pull surfaced here and applied only on click). Reuses the same
// badge/dropdown-panel shape as the upload queue above. See local-sync.js
// in the main process for the actual engine this reflects. ---

const syncStatusWrap = document.getElementById('sync-status-wrap');
const syncPushBtn = document.getElementById('sync-push-btn');
const syncPullBtn = document.getElementById('sync-pull-btn');
const syncStatusBtn = document.getElementById('sync-status-btn');
const syncStatusLabel = document.getElementById('sync-status-label');
const syncStatusBadge = document.getElementById('sync-status-badge');
const syncStatusPanel = document.getElementById('sync-status-panel');
const syncStatusBody = document.getElementById('sync-status-body');
const syncUnlinkBtn = document.getElementById('sync-unlink-btn');

const SYNC_STATUS_LABEL = { idle: 'Synced', syncing: 'Syncing…', blocked: 'Attention needed' };

function renderSyncStatus(res) {
  if (!res || !res.registered) {
    syncStatusWrap.hidden = true;
    return;
  }
  syncStatusWrap.hidden = false;
  syncStatusLabel.textContent = SYNC_STATUS_LABEL[res.status] || 'Synced';
  syncStatusBadge.hidden = res.pendingPullCount === 0;
  syncStatusBadge.textContent = String(res.pendingPullCount);

  // Always visible (not tucked inside the collapsed panel below) so a
  // pending pull is never something you have to think to go looking for —
  // just disabled with nothing to pull. Only re-armed when idle; mid-pull
  // it's left alone so a second click can't fire while one is in flight.
  if (!syncPullBtn.classList.contains('pulling')) {
    syncPullBtn.disabled = !res.pendingPullCount;
    syncPullBtn.textContent = res.pendingPullCount ? `Pull changes (${res.pendingPullCount})` : 'Pull changes';
  }

  // Only Basic-mode projects push manually — advisory/check-in still push
  // the instant a change is detected, protected by checkout, so there's
  // nothing for this button to do there.
  syncPushBtn.hidden = res.syncMode !== 'basic';
  if (res.syncMode === 'basic' && !syncPushBtn.classList.contains('pushing')) {
    syncPushBtn.disabled = !res.pendingPushCount;
    syncPushBtn.textContent = res.pendingPushCount ? `Push changes (${res.pendingPushCount})` : 'Push changes';
  }

  const sections = [];
  sections.push(`
    <div class="sync-status-line">
      <span class="sync-status-dot ${res.status}"></span>
      ${SYNC_STATUS_LABEL[res.status] || 'Synced'}${res.syncMode === 'basic' ? ' · Basic mode' : ''}
    </div>`);

  if (res.syncMode === 'basic') {
    sections.push(
      '<div class="sync-note warn">Unprotected — no checkout in Basic mode. Local changes wait for "Push changes"; whoever syncs last wins.</div>'
    );
  }

  if (res.conflicts.length) {
    sections.push('<div class="sync-section-label">Conflicts to resolve</div>');
    sections.push(
      res.conflicts
        .map(
          (c) => `<div class="sync-item-row">
            <div class="sync-item-path">${escapeHtml(c.relPath)}</div>
            <div class="sync-item-detail">See "${escapeHtml(c.conflictPath.split('/').pop())}" alongside it</div>
          </div>`
        )
        .join('')
    );
  }

  if (res.blocked.length) {
    sections.push('<div class="sync-section-label">Waiting to push</div>');
    sections.push(
      res.blocked
        .map(
          (b) => `<div class="sync-item-row">
            <div class="sync-item-path">${escapeHtml(b.relPath)}</div>
            <div class="sync-item-detail">${escapeHtml(b.reason)}</div>
          </div>`
        )
        .join('')
    );
  }

  if (!res.conflicts.length && !res.blocked.length && !res.pendingPullCount && !res.pendingPushCount) {
    sections.push('<div class="sync-note">Nothing pending.</div>');
  }

  syncStatusBody.innerHTML = sections.join('');
}

syncPullBtn.addEventListener('click', async () => {
  if (!currentProjectId) return;
  syncPullBtn.classList.add('pulling');
  syncPullBtn.disabled = true;
  syncPullBtn.textContent = 'Pulling…';
  try {
    const pullRes = await window.api.sync.pull(currentProjectId);
    if (!pullRes.ok) {
      alert('Pull failed: ' + pullRes.error);
    } else {
      const conflictNote = pullRes.conflicts ? `, ${pullRes.conflicts} conflict${pullRes.conflicts === 1 ? '' : 's'}` : '';
      const skippedNote = pullRes.skipped
        ? `, ${pullRes.skipped} skipped (push ${pullRes.skipped === 1 ? 'it' : 'them'} first)`
        : '';
      alert(`Pulled ${pullRes.pulled} file${pullRes.pulled === 1 ? '' : 's'}${conflictNote}${skippedNote}.`);
    }
  } finally {
    syncPullBtn.classList.remove('pulling');
  }
  await refreshSyncStatus();
  if (currentFolderId) await loadFolder(currentFolderId);
});

syncPushBtn.addEventListener('click', async () => {
  if (!currentProjectId) return;
  syncPushBtn.classList.add('pushing');
  syncPushBtn.disabled = true;
  syncPushBtn.textContent = 'Pushing…';
  try {
    const pushRes = await window.api.sync.push(currentProjectId);
    if (!pushRes.ok) {
      alert('Push failed: ' + pushRes.error);
    } else {
      const errorNote = pushRes.errors?.length
        ? `, ${pushRes.errors.length} failed (${pushRes.errors.map((e) => e.error).join('; ')})`
        : '';
      alert(`Pushed ${pushRes.pushed} file${pushRes.pushed === 1 ? '' : 's'}${errorNote}.`);
    }
  } finally {
    syncPushBtn.classList.remove('pushing');
  }
  await refreshSyncStatus();
  if (currentFolderId) await loadFolder(currentFolderId);
});

async function refreshSyncStatus() {
  if (!hasApi || !currentProjectId) {
    syncStatusWrap.hidden = true;
    return;
  }
  const res = await window.api.sync.getStatus(currentProjectId);
  renderSyncStatus(res);
}

let syncStatusPollTimer = null;
function startSyncStatusPolling() {
  if (syncStatusPollTimer) return;
  syncStatusPollTimer = setInterval(refreshSyncStatus, 15000);
}

// Drop zone for the current folder — dropping directly on a folder row is
// handled by that row's own listener (which stops propagation here), so
// this only fires for drops on empty space or a file row, i.e. "into
// whatever folder is currently open."
if (hasApi) {
  fileTableBodyEl.addEventListener('dragover', (e) => e.preventDefault());
  fileTableBodyEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    if (!currentFolderId) return;
    if (e.dataTransfer.types.includes('Files')) {
      await handleExternalFileDrop(e.dataTransfer.files, currentFolderId);
    } else {
      const raw = e.dataTransfer.getData('application/x-resync-item');
      if (raw) await handleInternalDrop(JSON.parse(raw), currentFolderId);
    }
  });
}
let demoMode = false;

function renderTree(breadcrumbs) {
  treeEl.innerHTML = '';
  breadcrumbs.forEach((crumb, i) => {
    const row = document.createElement('div');
    row.className = 'tree-row' + (i === breadcrumbs.length - 1 ? ' active' : '');
    row.style.paddingLeft = 10 + i * 14 + 'px';
    row.innerHTML = `<span class="chevron">${i < breadcrumbs.length - 1 ? '▾' : ''}</span>${escapeHtml(crumb.name)}`;
    row.addEventListener('click', () => loadFolder(crumb.id));

    // Same drop-target behavior as a folder row in the file list — lets
    // you drag a file straight up to an ancestor folder without having to
    // navigate there first and lose sight of what you're dragging. This is
    // the breadcrumb chain, not a full project tree, so only ancestors of
    // wherever you currently are are reachable this way.
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      if (e.dataTransfer.types.includes('Files')) {
        await handleExternalFileDrop(e.dataTransfer.files, crumb.id);
      } else {
        const raw = e.dataTransfer.getData('application/x-resync-item');
        if (raw) await handleInternalDrop(JSON.parse(raw), crumb.id);
      }
    });

    treeEl.appendChild(row);
  });
}

function renderBreadcrumbs(breadcrumbs) {
  breadcrumbsEl.innerHTML = '';
  breadcrumbs.forEach((crumb, i) => {
    const last = i === breadcrumbs.length - 1;
    const el = document.createElement(last ? 'span' : 'a');
    el.textContent = crumb.name;
    if (last) el.className = 'current';
    else el.addEventListener('click', () => loadFolder(crumb.id));
    breadcrumbsEl.appendChild(el);
    if (!last) breadcrumbsEl.appendChild(document.createTextNode('/'));
  });
}

// Downloads and displays one specific historical version — same dispatch
// path selectFile() uses for the latest, just pointed at an older blob.
async function previewSpecificVersion(file, versionId) {
  if (!confirmDiscardCsvEdits()) return;
  const c = classify(file);
  if (!c.previewKind) return;
  if (!hasApi) {
    setPreviewStatus('Preview requires the desktop app');
    return;
  }
  const res = await window.api.server.downloadVersion(versionId);
  if (!res.ok) {
    setPreviewStatus('Download failed: ' + res.error);
    return;
  }
  // No editCtx — editing only applies to a file's current/latest version,
  // since saving always adds a new version on top of the latest, not this
  // historical one.
  await dispatchPreview(c, new Uint8Array(res.data), file.name);
}

async function renderVersionHistory(file) {
  const container = document.getElementById('version-history-list');
  if (!container) return;
  container.innerHTML = '<div class="muted small">Loading…</div>';
  const res = await window.api.server.listVersions(file.id);
  if (!res.ok) {
    container.innerHTML = `<div class="muted small">Error: ${escapeHtml(res.error)}</div>`;
    return;
  }
  container.innerHTML = '';
  res.versions.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'version-row';
    row.innerHTML = `
      <div class="version-row-main">
        <div class="version-row-main-top">
          <span class="version-label">v${v.versionNumber}</span>
          ${i === 0 ? '<span class="version-current">CURRENT</span>' : ''}
        </div>
        ${v.message ? `<div class="version-message" title="${escapeHtml(v.message)}">${escapeHtml(v.message)}</div>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex:0 0 auto">
        <span class="version-date">${formatDate(v.createdAt)} · ${formatSize(v.size)}</span>
        <span class="version-author" title="${escapeHtml(v.uploadedBy)}">${escapeHtml(initialsOf(v.uploadedBy))}</span>
        ${i !== 0 && hasApi ? `<button class="row-action-btn version-restore-btn" title="Restore this version">${RESTORE_ICON}</button>` : ''}
      </div>`;

    row.querySelector('.version-row-main').addEventListener('click', () => previewSpecificVersion(file, v.id));

    const restoreBtn = row.querySelector('.version-restore-btn');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Restore v${v.versionNumber}? This adds a new version with that content — nothing is deleted.`)) return;
        restoreBtn.disabled = true;
        const r = await window.api.server.restoreVersion(file.id, v.id);
        restoreBtn.disabled = false;
        if (!r.ok) {
          alert('Could not restore: ' + r.error);
          return;
        }
        // Restoring auto-releases the lock server-side, same as any other
        // new-version upload — reflect that locally instead of waiting on
        // a full reload.
        file.lock = null;
        await loadFolder(currentFolderId);
        renderFileDetails(file);
      });
    }

    container.appendChild(row);
  });
}

function renderFileDetails(file) {
  if (!file) {
    fileDetailsEl.innerHTML = '<div class="muted">No file selected</div>';
    return;
  }
  const c = classify(file);
  const isMine = !!(file.lock && lastProfile && file.lock.userId === lastProfile.id);
  // Locking is only *enforced* in checkin mode — basic has no lock concept,
  // advisory tracks/shows it but never blocks the upload button itself
  // (the warning happens at click time instead, see below).
  const showLockUi = file.id && currentSyncMode !== 'basic';
  const canUpload = file.id && (currentSyncMode !== 'checkin' || (file.lock && isMine));

  fileDetailsEl.innerHTML = `
    <div>
      <div class="file-title">${escapeHtml(file.name)}</div>
      <div class="file-subtitle">${c.type}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="meta-row"><span class="k">Size</span><span class="v">${formatSize(file.size)}</span></div>
      <div class="meta-row"><span class="k">Modified</span><span class="v">${formatDate(file.updatedAt)}</span></div>
      ${file.uploadedBy ? `<div class="meta-row"><span class="k">Uploaded by</span><span class="v">${escapeHtml(file.uploadedBy)}</span></div>` : ''}
    </div>
    ${
      file.id && hasApi
        ? `<button id="open-file-btn" class="local-tool-btn" data-open-label="Open in default app">Open in default app</button>`
        : ''
    }
    ${
      file.id && hasApi && SLDASM_EXT.test(file.name)
        ? `<button id="generate-bom-btn" class="local-tool-btn">Generate BOM&hellip;</button>`
        : ''
    }
    ${
      showLockUi
        ? `<div class="lock-status ${file.lock ? (isMine ? 'mine' : 'other') : 'free'}">
            ${file.lock ? `&#128274; Checked out by ${isMine ? 'you' : escapeHtml(file.lock.name)}` : '&#128275; Available — not checked out'}
          </div>`
        : ''
    }
    ${
      showLockUi && hasApi
        ? file.lock
          ? `<button id="checkin-btn" class="local-tool-btn">Check In</button>`
          : `<button id="checkout-btn" class="local-tool-btn">Check Out</button>`
        : ''
    }
    ${
      file.id && hasApi
        ? `<button id="upload-version-btn" class="local-tool-btn" ${canUpload ? '' : 'disabled'} title="${canUpload ? '' : 'Check out this file first'}">Upload New Version&hellip;</button>`
        : ''
    }
    ${
      file.id && hasApi
        ? `<div>
            <div class="section-label">Tags</div>
            <div id="file-details-tags" class="file-tags"></div>
          </div>`
        : ''
    }
    <div>
      <div class="section-label">Version history</div>
      <div id="version-history-list" class="version-list"></div>
    </div>`;

  const openFileBtn = document.getElementById('open-file-btn');
  if (openFileBtn) {
    openFileBtn.addEventListener('click', async () => {
      openFileBtn.disabled = true;
      openFileBtn.textContent = 'Opening…';
      const res = await window.api.server.openFileInDefaultApp(file.id, file.latestVersionId, file.name);
      openFileBtn.disabled = false;
      openFileBtn.textContent = openFileBtn.dataset.openLabel;
      if (!res.ok) alert('Could not open file: ' + res.error);
    });

    // Upgrades the label to "Open in <App>" once the OS's registered
    // handler is resolved — deliberately async and non-blocking (the
    // registry/version-info lookup takes a moment) rather than delaying
    // the rest of the panel. Guarded against the user having already
    // selected a different file by the time this resolves.
    window.api.server.getDefaultAppName(file.name).then((res) => {
      if (!res.ok || !res.appName) return;
      if (selectedFileId !== file.id || document.getElementById('open-file-btn') !== openFileBtn) return;
      const label = `Open in ${res.appName}`;
      openFileBtn.dataset.openLabel = label;
      openFileBtn.textContent = label;
    });
  }

  const generateBomBtn = document.getElementById('generate-bom-btn');
  if (generateBomBtn) {
    generateBomBtn.addEventListener('click', async () => {
      generateBomBtn.disabled = true;
      generateBomBtn.textContent = 'Generating…';
      const res = await window.api.server.generateBOM(file.id, file.name, currentFolderId);
      generateBomBtn.disabled = false;
      generateBomBtn.textContent = 'Generate BOM…';
      if (!res.ok) {
        alert('Could not generate BOM: ' + res.error);
        return;
      }
      await loadFolder(currentFolderId);
      alert(`BOM saved as "${res.fileName}".`);
    });
  }

  const uploadVersionBtn = document.getElementById('upload-version-btn');
  if (uploadVersionBtn) {
    uploadVersionBtn.addEventListener('click', async () => {
      // Advisory mode never blocks the upload server-side, but it's still
      // worth a heads-up when you're about to overwrite something someone
      // else has open.
      if (currentSyncMode === 'advisory' && file.lock && !isMine) {
        if (!confirm(`${file.lock.name} has this file checked out. Upload a new version anyway?`)) return;
      }
      // Optional — skipping this (Cancel/Escape) still proceeds to the file
      // picker with no message, it doesn't abort the upload.
      const message = await showInputModal('Version comment (optional)');
      uploadVersionBtn.disabled = true;
      uploadVersionBtn.textContent = 'Uploading…';
      const res = await window.api.server.uploadVersion(file.id, message);
      uploadVersionBtn.disabled = false;
      uploadVersionBtn.textContent = 'Upload New Version…';
      if (res.canceled) return;
      if (!res.ok) {
        alert('Upload failed: ' + res.error);
        return;
      }
      // Uploading auto-releases the lock server-side — reflect that locally
      // instead of waiting on a full reload.
      file.lock = null;
      await loadFolder(currentFolderId);
      renderFileDetails(file);
    });
  }

  const checkoutBtn = document.getElementById('checkout-btn');
  if (checkoutBtn) {
    checkoutBtn.addEventListener('click', async () => {
      checkoutBtn.disabled = true;
      const res = await window.api.server.checkoutFile(file.id);
      checkoutBtn.disabled = false;
      if (!res.ok) {
        alert('Could not check out: ' + res.error);
        return;
      }
      file.lock = res.lock;
      await loadFolder(currentFolderId);
      renderFileDetails(file);
    });
  }

  const checkinBtn = document.getElementById('checkin-btn');
  if (checkinBtn) {
    checkinBtn.addEventListener('click', async () => {
      if (!isMine && !confirm(`This file is checked out by ${file.lock.name}. Check it in anyway?`)) return;
      checkinBtn.disabled = true;
      const res = await window.api.server.checkinFile(file.id);
      checkinBtn.disabled = false;
      if (!res.ok) {
        alert('Could not check in: ' + res.error);
        return;
      }
      file.lock = res.lock;
      await loadFolder(currentFolderId);
      renderFileDetails(file);
    });
  }

  if (file.id) renderVersionHistory(file);

  const detailsTagsEl = document.getElementById('file-details-tags');
  if (detailsTagsEl) {
    renderTagChips(file, detailsTagsEl, async () => {
      await loadFolder(currentFolderId);
      renderFileDetails(file);
    });
  }
}

async function selectFile(file, rowEl) {
  if (!confirmDiscardCsvEdits()) return;
  fileTableBodyEl.querySelectorAll('.file-row.selected').forEach((r) => r.classList.remove('selected'));
  if (rowEl) rowEl.classList.add('selected');
  selectedFileId = file.id;
  renderFileDetails(file);

  const c = classify(file);
  if (!c.previewKind) {
    clearPreview();
    return;
  }
  if (!hasApi) {
    setPreviewStatus('Preview requires the desktop app');
    return;
  }
  const res = await window.api.server.downloadVersion(file.latestVersionId);
  if (!res.ok) {
    setPreviewStatus('Download failed: ' + res.error);
    return;
  }
  await dispatchPreview(c, new Uint8Array(res.data), file.name, { fileId: file.id });
}

const DELETE_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const RESTORE_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>';

// --- File tags — chips rendered in both the row and the details panel,
// sharing one picker popover so "which tags does this project have" is
// only ever fetched from one place. ---

let closeOpenTagPicker = null;

function renderTagChips(file, containerEl, onChange) {
  containerEl.innerHTML = '';
  (file.tags || []).forEach((tag) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.style.background = tag.color || '#75868a';
    chip.style.color = contrastTextColor(tag.color || '#75868a');
    chip.innerHTML = `${escapeHtml(tag.name)} <span class="tag-remove" title="Remove tag">&times;</span>`;
    chip.querySelector('.tag-remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await window.api.server.removeFileTag(file.id, tag.id);
      if (!res.ok) {
        alert('Could not remove tag: ' + res.error);
        return;
      }
      file.tags = (file.tags || []).filter((t) => t.id !== tag.id);
      await onChange();
    });
    containerEl.appendChild(chip);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'tag-add-btn';
  addBtn.title = 'Add tag';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openTagPicker(file, addBtn, onChange);
  });
  containerEl.appendChild(addBtn);
}

async function openTagPicker(file, anchorEl, onChange) {
  if (closeOpenTagPicker) closeOpenTagPicker();

  const res = await window.api.server.listProjectTags(currentProjectId);
  if (!res.ok) {
    alert('Could not load tags: ' + res.error);
    return;
  }

  const picker = document.createElement('div');
  picker.className = 'tag-picker';
  const rect = anchorEl.getBoundingClientRect();
  picker.style.top = rect.bottom + 4 + 'px';
  picker.style.left = rect.left + 'px';

  const assignedIds = new Set((file.tags || []).map((t) => t.id));
  picker.innerHTML = res.tags.length
    ? res.tags
        .map(
          (t) => `
    <div class="tag-picker-row" data-tag-id="${t.id}">
      <span class="tag-picker-dot" style="background:${t.color}"></span>
      <span style="flex:1">${escapeHtml(t.name)}</span>
      <span>${assignedIds.has(t.id) ? '&#10003;' : ''}</span>
    </div>`
        )
        .join('')
    : '<div class="muted small" style="padding:6px 8px">No tags yet — add one in Settings.</div>';

  document.body.appendChild(picker);

  function cleanup() {
    picker.remove();
    document.removeEventListener('click', outsideClick, true);
    closeOpenTagPicker = null;
  }
  function outsideClick(e) {
    if (!picker.contains(e.target) && e.target !== anchorEl) cleanup();
  }
  setTimeout(() => document.addEventListener('click', outsideClick, true), 0);
  closeOpenTagPicker = cleanup;

  picker.querySelectorAll('.tag-picker-row').forEach((row) => {
    row.addEventListener('click', async (e) => {
      e.stopPropagation();
      const tagId = Number(row.dataset.tagId);
      const tag = res.tags.find((t) => t.id === tagId);
      const isAssigned = assignedIds.has(tagId);
      const r = isAssigned
        ? await window.api.server.removeFileTag(file.id, tagId)
        : await window.api.server.addFileTag(file.id, tagId);
      if (!r.ok) {
        alert('Could not update tag: ' + r.error);
        return;
      }
      file.tags = isAssigned ? (file.tags || []).filter((t) => t.id !== tagId) : [...(file.tags || []), tag];
      cleanup();
      await onChange();
    });
  });
}

async function deleteItem(file) {
  const kind = file.isFolder ? 'folder' : 'file';
  if (!confirm(`Delete ${kind} "${file.name}"? You can restore it later from Trash.`)) return;
  const res = file.isFolder ? await window.api.server.deleteFolder(file.id) : await window.api.server.deleteFile(file.id);
  if (!res.ok) {
    alert('Could not delete: ' + res.error);
    return;
  }
  if (!file.isFolder && selectedFileId === file.id) {
    selectedFileId = null;
    renderFileDetails(null);
    clearPreview();
  }
  await loadFolder(currentFolderId);
}

// Office/SolidWorks-style lock file left next to whatever's currently open
// ("~$Part1.SLDPRT") — never real content, so it shouldn't get uploaded if
// it's swept up in a drag of a whole folder's contents.
const LOCK_FILE_RE = /^~\$/;

function handleExternalFileDrop(fileList, targetFolderId) {
  const filePaths = Array.from(fileList)
    .map((file) => window.api.getPathForFile(file))
    .filter(Boolean)
    .filter((p) => !LOCK_FILE_RE.test(p.split(/[\\/]/).pop()));
  if (filePaths.length) enqueueUploads(targetFolderId, filePaths);
}

async function handleInternalDrop(draggedItem, targetFolderId) {
  if (draggedItem.id === targetFolderId) return;
  const res = draggedItem.isFolder
    ? await window.api.server.moveFolder(draggedItem.id, targetFolderId)
    : await window.api.server.moveFile(draggedItem.id, targetFolderId);
  if (!res.ok) {
    alert('Could not move: ' + res.error);
    return;
  }
  await loadFolder(currentFolderId);
}

function renderFileTable(items) {
  fileTableBodyEl.innerHTML = '';
  for (const file of items) {
    const c = classify(file);
    const row = document.createElement('div');
    row.className = 'file-row';
    row.draggable = true;
    row.dataset.id = file.id;
    row.dataset.isFolder = String(!!file.isFolder);
    row.innerHTML = `
      <div class="name-cell">
        <div class="file-badge" style="background:${c.bg}" title="${escapeHtml(c.badge)}">${fileIconSvg(c.glyph, c.fg)}</div>
        <span class="file-name">${escapeHtml(file.name)}</span>
        ${file.lock ? `<span class="lock-badge" title="Checked out by ${escapeHtml(file.lock.name)}">&#128274;</span>` : ''}
        ${!file.isFolder && hasApi ? '<span class="file-tags"></span>' : ''}
      </div>
      <div class="file-type">${c.type}</div>
      <div class="file-size">${file.isFolder ? '—' : formatSize(file.size)}</div>
      <div class="file-modified">${file.isFolder ? '—' : formatDate(file.updatedAt)}</div>
      <div class="row-actions">
        <button class="row-action-btn danger delete-btn" title="Delete">${DELETE_ICON}</button>
      </div>`;

    if (file.isFolder) {
      row.addEventListener('click', () => loadFolder(file.id));
    } else {
      row.addEventListener('click', () => selectFile(file, row));
      const tagsEl = row.querySelector('.file-tags');
      if (tagsEl) {
        renderTagChips(file, tagsEl, async () => {
          await loadFolder(currentFolderId);
          if (selectedFileId === file.id) renderFileDetails(file);
        });
      }
    }

    row.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteItem(file);
    });

    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-resync-item', JSON.stringify({ id: file.id, isFolder: file.isFolder }));
    });

    if (file.isFolder) {
      row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.add('drop-target');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
      row.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('drop-target');
        if (e.dataTransfer.types.includes('Files')) {
          await handleExternalFileDrop(e.dataTransfer.files, file.id);
        } else {
          const raw = e.dataTransfer.getData('application/x-resync-item');
          if (raw) await handleInternalDrop(JSON.parse(raw), file.id);
        }
      });
    }

    fileTableBodyEl.appendChild(row);
  }
  if (!items.length) {
    fileTableBodyEl.innerHTML = '<div class="muted" style="padding:24px">Empty folder</div>';
  }
}

async function loadFolder(folderId) {
  if (!hasApi || !folderId) return;
  searchFilterActive = false;
  currentFolderId = folderId;
  fileTableBodyEl.innerHTML = '<div class="muted" style="padding:24px">Loading…</div>';
  const res = await window.api.server.getFolder(folderId);
  if (!res.ok) {
    fileTableBodyEl.innerHTML = `<div class="muted" style="padding:24px">Error: ${escapeHtml(res.error)}</div>`;
    return;
  }
  currentProjectId = res.folder.projectId;
  currentSyncMode = res.syncMode || 'checkin';
  renderTree(res.breadcrumbs);
  renderBreadcrumbs(res.breadcrumbs);
  renderFileTable(res.items);
  refreshSyncStatus();
}

function openProject(project) {
  currentProjectId = project.id;
  switchScreen('browser');
  loadFolder(project.rootFolderId);
}

function showNoProjectSelected() {
  currentProjectId = null;
  currentFolderId = null;
  treeEl.innerHTML = '';
  breadcrumbsEl.innerHTML = '';
  fileTableBodyEl.innerHTML =
    '<div class="muted" style="padding:24px">Select a project from the Projects tab, or add one.</div>';
  syncStatusWrap.hidden = true;
}

function showSignedOutBrowser() {
  currentProjectId = null;
  currentFolderId = null;
  treeEl.innerHTML = '';
  breadcrumbsEl.innerHTML = '';
  fileTableBodyEl.innerHTML = '<div class="muted" style="padding:24px">Sign in (top right) to browse your files.</div>';
  syncStatusWrap.hidden = true;
}

function showDemoModeBrowser() {
  currentProjectId = null;
  currentFolderId = null;
  treeEl.innerHTML = '';
  breadcrumbsEl.innerHTML = '<span class="muted">Demo mode</span>';
  fileTableBodyEl.innerHTML =
    '<div class="muted" style="padding:24px">No server connected. Use &ldquo;Open local file&hellip;&rdquo; in the sidebar to preview any file — nothing is uploaded or saved.</div>';
}

// --- Search (current project only — files.js has no cross-project index) ---
//
// The search box supports several operators alongside plain name text:
//   tag:<name>    only files carrying that tag (repeat for AND: tag:a tag:b)
//   type:<value>  only files of that type — either a literal extension
//                 (type:sldprt), a broader category (type:3d, type:image,
//                 type:code, type:text, type:csv, type:pdf), or "folder"/
//                 "folders" to show only folders. Category names expand to
//                 the same extension groups classify() uses for file icons,
//                 so the two stay in sync by construction.
//   by:<name>     only files whose latest version was uploaded by someone
//                 matching that name/email (partial match)
//   size:<value>  only files at or beyond that size — ">10mb", "<500kb",
//                 ">=1gb", or a bare number/unit ("10mb", meaning >=10mb).
//                 Passed straight through; the server does the actual
//                 unit/operator parsing (see resync-server's
//                 parseSizeFilter) so it's only implemented once.
//   locked:<value> checkout status — yes/no (any/no lock), me (checked out
//                 by you), or a name/email for a specific person
// tag:/type: are the only operators with client-side expansion (type: into
// ext/kind); everything else forwards its raw value straight to the
// server. Everything left over is free text matched against the name,
// same as before. See parseSearchQuery().

const TYPE_EXTENSIONS = {
  '3d': ['step', 'stp', 'iges', 'igs', 'brep', 'stl', 'obj', 'gltf', 'glb', 'sldprt', 'sldasm'],
  model: ['step', 'stp', 'iges', 'igs', 'brep', 'stl', 'obj', 'gltf', 'glb', 'sldprt', 'sldasm'],
  models: ['step', 'stp', 'iges', 'igs', 'brep', 'stl', 'obj', 'gltf', 'glb', 'sldprt', 'sldasm'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'],
  images: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'],
  pdf: ['pdf'],
  code: ['py', 'js', 'ts', 'json', 'yaml', 'yml', 'xml', 'c', 'cpp', 'h', 'java', 'go', 'rs', 'sh'],
  text: ['txt', 'md', 'log'],
  csv: ['csv'],
};

// Whitespace-splits the query EXCEPT inside double quotes, so a value with
// spaces in it (a tag named "In Review", a person's full name) can be
// typed as one token: tag:"In Review". Quotes are stripped from the
// result. Autocomplete (below) only ever inserts a quoted value when the
// value itself contains a space, so this is what makes accepting a
// multi-word suggestion actually round-trip correctly.
function tokenizeSearchQuery(raw) {
  const tokens = [];
  let current = '';
  let inQuotes = false;
  for (const c of raw) {
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if (/\s/.test(c) && !inQuotes) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseSearchQuery(raw) {
  const tags = [];
  const exts = new Set();
  let kind = 'all';
  let by = '';
  let size = '';
  let locked = '';
  const freeWords = [];
  for (const token of tokenizeSearchQuery(raw.trim())) {
    const m = token.match(/^(tag|type|by|size|locked):(.+)$/i);
    if (!m) {
      freeWords.push(token);
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === 'tag') {
      tags.push(value);
    } else if (key === 'by') {
      by = value;
    } else if (key === 'size') {
      size = value;
    } else if (key === 'locked') {
      locked = value;
    } else {
      const v = value.toLowerCase().replace(/^\./, '');
      if (v === 'folder' || v === 'folders' || v === 'dir') kind = 'folders';
      else if (TYPE_EXTENSIONS[v]) TYPE_EXTENSIONS[v].forEach((e) => exts.add(e));
      else exts.add(v);
    }
  }
  return { query: freeWords.join(' '), tags, exts: Array.from(exts), kind, by, size, locked };
}

// --- Search autocomplete — typing an operator's key (tag:, by:, locked:,
// type:) pops up real values to pick from instead of making you guess
// exact spelling. Only active while there's no space yet after the colon
// (see detectOperatorContext) — once a value's accepted, or free text
// follows, normal search takes back over.

const TYPE_SUGGESTIONS = ['3d', 'image', 'pdf', 'code', 'text', 'csv', 'folder'];
const LOCKED_SUGGESTIONS = ['yes', 'no', 'me'];

// Cached per project for the lifetime of viewing it — tags/people rarely
// change mid-session, and re-fetching on every keystroke would make the
// dropdown feel laggy for no real benefit.
let searchTagsCache = null; // { projectId, tags: [{name, color}] }
let searchPeopleCache = null; // { projectId, people: [{name, email}] }

async function getCachedSearchTags() {
  if (searchTagsCache && searchTagsCache.projectId === currentProjectId) return searchTagsCache.tags;
  const res = await window.api.server.listProjectTags(currentProjectId);
  const tags = res.ok ? res.tags : [];
  searchTagsCache = { projectId: currentProjectId, tags };
  return tags;
}

async function getCachedSearchPeople() {
  if (searchPeopleCache && searchPeopleCache.projectId === currentProjectId) return searchPeopleCache.people;
  const res = await window.api.server.getProjectMembers(currentProjectId);
  const people = res.ok ? [res.owner, ...res.members].filter(Boolean) : [];
  searchPeopleCache = { projectId: currentProjectId, people };
  return people;
}

// Finds the operator token the caret is currently inside, if any — e.g.
// typing "tag:ur|" (| = caret) returns {key:'tag', partial:'ur', ...}.
// Deliberately only recognizes the no-space-yet case (see
// tokenizeSearchQuery's docstring for why multi-word values are typed
// quoted instead) — that covers autocomplete's actual job, picking a
// value before you've finished typing it by hand.
function detectOperatorContext(input) {
  const value = input.value;
  const caret = input.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const m = before.match(/(?:^|\s)(tag|type|by|size|locked):([^"\s]*)$/i);
  if (!m) return null;
  const leadingSpace = /^\s/.test(m[0]) ? 1 : 0;
  return { key: m[1].toLowerCase(), partial: m[2], tokenStart: caret - m[0].length + leadingSpace, caret };
}

async function suggestionsFor(key, partial) {
  const p = partial.toLowerCase();
  if (key === 'tag') {
    const tags = await getCachedSearchTags();
    return tags.filter((t) => t.name.toLowerCase().includes(p)).map((t) => ({ value: t.name, label: t.name, color: t.color }));
  }
  if (key === 'type') {
    return TYPE_SUGGESTIONS.filter((v) => v.includes(p)).map((v) => ({ value: v, label: v }));
  }
  if (key === 'by' || key === 'locked') {
    const people = (await getCachedSearchPeople())
      .filter((m) => (m.name || m.email || '').toLowerCase().includes(p) || (m.email || '').toLowerCase().includes(p))
      // Inserted value is the email, never the display name — names can
      // contain spaces, and this box only auto-quotes fixed keywords, not
      // person lookups (an email round-trips as a single token for free).
      .map((m) => ({ value: m.email, label: m.name ? `${m.name} (${m.email})` : m.email }));
    if (key === 'locked') {
      const fixed = LOCKED_SUGGESTIONS.filter((v) => v.includes(p)).map((v) => ({ value: v, label: v }));
      return [...fixed, ...people];
    }
    return people;
  }
  return []; // size: has no fixed vocabulary — free-typed value only
}

function insertSearchToken(input, ctx, value) {
  const needsQuotes = /\s/.test(value);
  const insertText = `${ctx.key}:${needsQuotes ? `"${value}"` : value} `;
  input.value = input.value.slice(0, ctx.tokenStart) + insertText + input.value.slice(ctx.caret);
  const newCaret = ctx.tokenStart + insertText.length;
  input.setSelectionRange(newCaret, newCaret);
  input.focus();
}

let activeSuggestions = []; // [{value, label, color?}]
let activeSuggestionCtx = null;
let activeSuggestionIndex = -1;

function highlightSuggestion(index) {
  const rows = searchResultsEl.querySelectorAll('.search-suggestion-row');
  rows.forEach((r, i) => r.classList.toggle('active', i === index));
  if (index >= 0 && rows[index]) rows[index].scrollIntoView({ block: 'nearest' });
}

function acceptSuggestion(index) {
  if (!activeSuggestionCtx || !activeSuggestions[index]) return;
  insertSearchToken(searchInputEl, activeSuggestionCtx, activeSuggestions[index].value);
  clearSuggestions();
  searchInputEl.dispatchEvent(new Event('input'));
}

function clearSuggestions() {
  activeSuggestions = [];
  activeSuggestionCtx = null;
  activeSuggestionIndex = -1;
  searchResultsEl.hidden = true;
  searchResultsEl.innerHTML = '';
}

async function showSearchSuggestions(ctx) {
  const suggestions = await suggestionsFor(ctx.key, ctx.partial);
  // The user may have kept typing (or left the token) while the lookup
  // was in flight — only render if this is still the live context.
  const stillLive = detectOperatorContext(searchInputEl);
  if (!stillLive || stillLive.key !== ctx.key || stillLive.tokenStart !== ctx.tokenStart) return;

  activeSuggestions = suggestions;
  activeSuggestionCtx = ctx;
  activeSuggestionIndex = -1;

  if (!suggestions.length) {
    searchResultsEl.hidden = true;
    searchResultsEl.innerHTML = '';
    return;
  }
  searchResultsEl.innerHTML = suggestions
    .map(
      (s, i) => `
    <div class="search-result-row search-suggestion-row" data-index="${i}">
      ${s.color ? `<span class="search-suggestion-dot" style="background:${escapeHtml(s.color)}"></span>` : '<span class="search-result-icon">&#128269;</span>'}
      <span class="search-result-name">${escapeHtml(s.label)}</span>
    </div>`
    )
    .join('');
  searchResultsEl.hidden = false;
  searchResultsEl.querySelectorAll('.search-suggestion-row').forEach((row) => {
    row.addEventListener('click', () => acceptSuggestion(Number(row.dataset.index)));
  });
}

const searchBoxEl = document.querySelector('.search-box');
const searchInputEl = document.getElementById('search-input');
const searchResultsEl = document.getElementById('search-results');
let searchDebounceTimer = null;

// Search doesn't show a separate results list — pressing Enter filters the
// real file table in place (same rows, same click/rename/delete/preview
// behavior), so a search hit behaves exactly like any other file. This flag
// just tracks whether the table's current contents are a filtered set
// rather than a real folder, so the breadcrumb bar can offer a way back.
let searchFilterActive = false;

function renderSearchFilterBreadcrumb(rawQuery, count) {
  breadcrumbsEl.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'current';
  label.textContent = `Search results for "${rawQuery.trim()}" (${count})`;
  const clear = document.createElement('a');
  clear.textContent = 'Clear';
  clear.addEventListener('click', () => {
    searchInputEl.value = '';
    exitSearchFilter();
    searchInputEl.focus();
  });
  breadcrumbsEl.appendChild(label);
  breadcrumbsEl.appendChild(document.createTextNode(' · '));
  breadcrumbsEl.appendChild(clear);
}

function exitSearchFilter() {
  if (!searchFilterActive) return;
  searchFilterActive = false;
  if (currentFolderId) loadFolder(currentFolderId);
}

async function applySearchFilter(rawQuery) {
  const parsed = parseSearchQuery(rawQuery);
  const hasFilters =
    parsed.query || parsed.tags.length || parsed.exts.length || parsed.kind !== 'all' || parsed.by || parsed.size || parsed.locked;
  if (!currentProjectId) return;
  if (!hasFilters) {
    exitSearchFilter();
    return;
  }
  const res = await window.api.server.searchProject(currentProjectId, parsed);
  if (!res.ok) return;

  switchScreen('browser');
  searchFilterActive = true;
  const items = [...res.folders, ...res.files];
  renderFileTable(items);
  renderSearchFilterBreadcrumb(rawQuery, items.length);
}

// --- Trash (soft-deleted files/folders for the current project) ---

const trashBtn = document.getElementById('trash-btn');
const trashOverlay = document.getElementById('trash-overlay');
const trashListEl = document.getElementById('trash-list');
const trashCloseBtn = document.getElementById('trash-close-btn');
let trashModalProjectId = null;

// --- Settings (local sync folder) ---

const settingsBtn = document.getElementById('settings-btn');
const settingsOverlay = document.getElementById('settings-overlay');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const chooseSyncFolderBtn = document.getElementById('choose-sync-folder-btn');
const syncFolderPathEl = document.getElementById('sync-folder-path');

async function refreshSyncFolderPath() {
  const res = await window.api.settings.getSyncFolder();
  syncFolderPathEl.textContent = res.syncFolder || 'Not set';
}

const settingsServerUrlEl = document.getElementById('settings-server-url');
const settingsChangeServerBtn = document.getElementById('settings-change-server-btn');

async function refreshSettingsServerUrl() {
  const res = await window.api.settings.getServerUrl();
  settingsServerUrlEl.textContent = res.serverUrl || 'Not connected';
}

function openSettings() {
  settingsOverlay.hidden = false;
  refreshSyncFolderPath();
  refreshSettingsTags();
  refreshSettingsServerUrl();
  refreshUpdateStatus();
}

// --- Appearance (theme) — works with or without a server connection, so
// it's wired unconditionally rather than inside the `if (hasApi)` blocks. ---

// Only the Electron build has a hidden native titlebar to make room for
// (see main.js) — the plain-browser dev server keeps its normal layout.
document.documentElement.classList.toggle('electron-app', hasApi);

const themeOptionBtns = document.querySelectorAll('.theme-option');
const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
const EXPLICIT_THEMES = ['light', 'dark', 'resync'];

// 'system' never resolves to the RESYNC (teal) variant — that one's an
// explicit-only choice, not something the OS light/dark preference maps to.
function resolvedThemeKey() {
  const choice = document.documentElement.dataset.theme;
  if (EXPLICIT_THEMES.includes(choice)) return choice;
  return darkMediaQuery.matches ? 'dark' : 'light';
}

function syncTitlebarOverlay() {
  if (hasApi) window.api.theme.setOverlay(resolvedThemeKey());
}

// Resolves any CSS color (oklch() included) to a real RGB hex via a 1x1
// canvas — Canvas2D's color parser understands the full CSS Color 4 syntax
// this palette uses, which THREE.Color's own parser does not.
function resolveCssColorToHex(cssColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = cssColor;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return (r << 16) | (g << 8) | b;
}

function syncViewerBackground() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--rs-canvas-bg').trim();
  previewViewer.setBackground(resolveCssColorToHex(raw));
}

function applyTheme(choice) {
  const persisted = EXPLICIT_THEMES.includes(choice) ? choice : null;
  if (persisted) {
    document.documentElement.dataset.theme = persisted;
  } else {
    delete document.documentElement.dataset.theme;
  }
  // Persisted in the main process (userData/settings.json), not
  // localStorage — see the note on getInitialTheme() in index.html for why.
  // Falls back to localStorage outside Electron (plain-browser dev server).
  if (hasApi) window.api.settings.setTheme(persisted);
  else if (persisted) localStorage.setItem('resync-theme', persisted);
  else localStorage.removeItem('resync-theme');
  themeOptionBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.themeChoice === choice));
  syncTitlebarOverlay();
  syncViewerBackground();
}

themeOptionBtns.forEach((btn) => btn.addEventListener('click', () => applyTheme(btn.dataset.themeChoice)));
// Keeps the native titlebar and 3D viewport in sync if the OS theme flips
// live while "System" is selected — the CSS media query already repaints
// the page itself for free, this just carries the same change over to the
// two pieces CSS can't reach on its own.
darkMediaQuery.addEventListener('change', () => {
  if (!EXPLICIT_THEMES.includes(document.documentElement.dataset.theme)) {
    syncTitlebarOverlay();
    syncViewerBackground();
  }
});
applyTheme(document.documentElement.dataset.theme || 'system');

// --- Check for updates (GitHub Releases) ---

const updateBannerEl = document.getElementById('update-banner');
const updateBannerTextEl = document.getElementById('update-banner-text');
const updateBannerVersionEl = document.getElementById('update-banner-version');
const updateBannerActionsEl = document.getElementById('update-banner-actions');
const updateBannerUpdateBtn = document.getElementById('update-banner-update-btn');
const updateBannerViewBtn = document.getElementById('update-banner-view-btn');
const updateBannerDismissBtn = document.getElementById('update-banner-dismiss-btn');
const settingsVersionEl = document.getElementById('settings-version');
const settingsCheckUpdatesBtn = document.getElementById('settings-check-updates-btn');
const settingsUpdateBtn = document.getElementById('settings-update-btn');

let latestReleaseUrl = null;
let latestReleaseVersion = null;
let updating = false;

async function refreshUpdateStatus({ manual = false } = {}) {
  if (!hasApi || updating) return;
  const res = await window.api.checkForUpdates();
  if (!res.ok) {
    settingsVersionEl.textContent = `Version ${res.currentVersion} · Couldn't check for updates: ${res.error}`;
    if (manual) alert('Could not check for updates: ' + res.error);
    return;
  }
  latestReleaseUrl = res.releaseUrl;
  latestReleaseVersion = res.latestVersion;
  settingsVersionEl.textContent = res.updateAvailable
    ? `Version ${res.currentVersion} · ${res.latestVersion} available`
    : `Version ${res.currentVersion} · Up to date`;
  settingsUpdateBtn.hidden = !res.updateAvailable;

  const alreadyDismissed = res.dismissedVersion === res.latestVersion;
  if (res.updateAvailable && (!alreadyDismissed || manual)) {
    updateBannerVersionEl.textContent = res.latestVersion;
    updateBannerEl.hidden = false;
  } else if (!res.updateAvailable) {
    updateBannerEl.hidden = true;
  }
  if (manual && !res.updateAvailable) alert(`You're up to date (${res.currentVersion}).`);
}

// Shared by the banner's "Update now" and Settings' "Update now" — download
// the release with live progress, hand off to the detached swap-and-relaunch
// script (see main.js), then quit once the user's actually seen it happen
// rather than the process disappearing out from under an in-flight action.
async function startUpdate() {
  if (updating || !latestReleaseVersion) return;
  updating = true;

  updateBannerActionsEl.hidden = true;
  updateBannerDismissBtn.hidden = true;
  updateBannerEl.hidden = false;
  settingsUpdateBtn.disabled = true;
  settingsCheckUpdatesBtn.disabled = true;

  const setProgressText = (text) => {
    updateBannerTextEl.textContent = text;
    settingsVersionEl.textContent = text;
  };
  setProgressText(`Downloading Resync ${latestReleaseVersion}… 0%`);

  const res = await window.api.performUpdate();
  if (!res.ok) {
    alert('Update failed: ' + res.error);
    updating = false;
    updateBannerActionsEl.hidden = false;
    updateBannerDismissBtn.hidden = false;
    settingsUpdateBtn.disabled = false;
    settingsCheckUpdatesBtn.disabled = false;
    return;
  }

  setProgressText(`Restarting to finish updating to ${res.version}…`);
  setTimeout(() => window.api.confirmQuitForUpdate(), 900);
}

if (hasApi) {
  window.api.onUpdateProgress(({ fraction, label }) => {
    if (!updating) return;
    const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    const text = `${label} ${pct}%`;
    updateBannerTextEl.textContent = text;
    settingsVersionEl.textContent = text;
  });
}

updateBannerUpdateBtn.addEventListener('click', startUpdate);
settingsUpdateBtn.addEventListener('click', startUpdate);
updateBannerViewBtn.addEventListener('click', () => {
  if (latestReleaseUrl) window.api.openExternal(latestReleaseUrl);
});
updateBannerDismissBtn.addEventListener('click', () => {
  updateBannerEl.hidden = true;
  window.api.dismissUpdate(updateBannerVersionEl.textContent);
});
settingsCheckUpdatesBtn.addEventListener('click', () => refreshUpdateStatus({ manual: true }));

if (hasApi) refreshUpdateStatus();

// --- Settings > Tags (create/delete tags for the currently open project) ---

const settingsTagsListEl = document.getElementById('settings-tags-list');
const tagNewForm = document.getElementById('tag-new-form');
const tagNewNameInput = document.getElementById('tag-new-name');
const tagNewColorInput = document.getElementById('tag-new-color');

async function refreshSettingsTags() {
  if (!currentProjectId) {
    settingsTagsListEl.innerHTML = '<div class="muted small">Open a project to manage its tags.</div>';
    tagNewForm.hidden = true;
    return;
  }
  tagNewForm.hidden = false;
  settingsTagsListEl.innerHTML = '<div class="muted small">Loading…</div>';
  const res = await window.api.server.listProjectTags(currentProjectId);
  if (!res.ok) {
    settingsTagsListEl.innerHTML = `<div class="muted small">Error: ${escapeHtml(res.error)}</div>`;
    return;
  }
  settingsTagsListEl.innerHTML =
    res.tags
      .map(
        (t) => `
    <div class="tag-manage-row" data-id="${t.id}">
      <span class="tag-chip tag-manage-chip" style="background:${t.color};color:${contrastTextColor(t.color)}">${escapeHtml(t.name)}</span>
      <span class="muted small tag-manage-count">${t.fileCount} file${t.fileCount === 1 ? '' : 's'}</span>
      <button class="row-action-btn danger tag-delete-btn" title="Delete tag">${DELETE_ICON}</button>
    </div>`
      )
      .join('') || '<div class="muted small">No tags yet.</div>';

  settingsTagsListEl.querySelectorAll('.tag-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.closest('.tag-manage-row').dataset.id);
      if (!confirm('Delete this tag? It will be removed from every file that has it.')) return;
      const r = await window.api.server.deleteTag(id);
      if (!r.ok) {
        alert('Could not delete tag: ' + r.error);
        return;
      }
      await refreshSettingsTags();
      if (currentFolderId) loadFolder(currentFolderId);
    });
  });
}

if (hasApi) {
  tagNewForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentProjectId) return;
    const name = tagNewNameInput.value.trim();
    if (!name) return;
    const res = await window.api.server.createTag(currentProjectId, name, tagNewColorInput.value);
    if (!res.ok) {
      alert('Could not create tag: ' + res.error);
      return;
    }
    tagNewForm.reset();
    tagNewColorInput.value = '#0491ad';
    refreshSettingsTags();
  });
}

// --- Activity feed (per project, visible to all members) ---

const activityBtn = document.getElementById('activity-btn');
const activityOverlay = document.getElementById('activity-overlay');
const activityCloseBtn = document.getElementById('activity-close-btn');
const activityListEl = document.getElementById('activity-list');

function describeActivity(e) {
  const d = e.detail || {};
  switch (e.action) {
    case 'folder.create':
      return `created folder <strong>${escapeHtml(d.name)}</strong>`;
    case 'folder.rename':
      return `renamed <strong>${escapeHtml(d.from)}</strong> to <strong>${escapeHtml(d.to)}</strong>`;
    case 'folder.move':
      return `moved <strong>${escapeHtml(d.name)}</strong>`;
    case 'folder.delete':
      return `deleted folder <strong>${escapeHtml(d.name)}</strong>`;
    case 'folder.restore':
      return `restored folder <strong>${escapeHtml(d.name)}</strong>`;
    case 'file.upload':
      return `uploaded <strong>${escapeHtml(d.name)}</strong>`;
    case 'file.new_version':
      return `uploaded v${d.versionNumber} of <strong>${escapeHtml(d.name)}</strong>`;
    case 'file.rename':
      return `renamed <strong>${escapeHtml(d.from)}</strong> to <strong>${escapeHtml(d.to)}</strong>`;
    case 'file.move':
      return `moved <strong>${escapeHtml(d.name)}</strong>`;
    case 'file.delete':
      return `deleted <strong>${escapeHtml(d.name)}</strong>`;
    case 'file.restore':
      return `restored <strong>${escapeHtml(d.name)}</strong>`;
    case 'file.checkout':
      return `checked out <strong>${escapeHtml(d.name)}</strong>`;
    case 'file.checkin':
      return `checked in <strong>${escapeHtml(d.name)}</strong>`;
    case 'project.share':
      return `shared the project with <strong>${escapeHtml(d.sharedWith)}</strong> as ${escapeHtml(d.role)}`;
    case 'project.unshare':
      return `removed <strong>${escapeHtml(d.removed)}</strong> from the project`;
    case 'project.role_change':
      return `changed a member's role to <strong>${escapeHtml(d.newRole)}</strong>`;
    case 'project.sync_mode_change':
      return `changed the sync mode to <strong>${escapeHtml(d.syncMode)}</strong>`;
    default:
      return escapeHtml(e.action);
  }
}

async function refreshActivity(projectId) {
  activityListEl.innerHTML = '<div class="muted small">Loading…</div>';
  const res = await window.api.server.getProjectActivity(projectId);
  if (!res.ok) {
    activityListEl.innerHTML = `<div class="muted small">Error: ${escapeHtml(res.error)}</div>`;
    return;
  }
  activityListEl.innerHTML =
    res.entries
      .map(
        (e) => `
    <div class="activity-entry-row">
      <div class="activity-entry-text"><strong>${escapeHtml(e.actor)}</strong> ${describeActivity(e)}</div>
      <div class="activity-entry-time">${formatDateTime(e.createdAt)}</div>
    </div>`
      )
      .join('') || '<div class="muted small">No activity yet.</div>';
}

function openActivity(projectId) {
  activityOverlay.hidden = false;
  refreshActivity(projectId);
}

// --- Notifications ---

const notifBtn = document.getElementById('notif-btn');
const notifDot = document.getElementById('notif-dot');
const notifPanel = document.getElementById('notif-panel');
const notifListEl = document.getElementById('notif-list');
const notifMarkAllBtn = document.getElementById('notif-mark-all-btn');
let notifPollTimer = null;

async function refreshNotifications() {
  const res = await window.api.server.listNotifications();
  if (!res.ok) return;
  notifDot.hidden = res.unreadCount === 0;
  notifListEl.innerHTML =
    res.notifications
      .map(
        (n) => `
    <div class="notif-row ${n.read ? '' : 'unread'}" data-id="${n.id}">
      <div class="notif-message">${escapeHtml(n.message)}</div>
      <div class="notif-time">${formatDateTime(n.createdAt)}</div>
    </div>`
      )
      .join('') || '<div class="muted small" style="padding:14px">No notifications yet.</div>';

  notifListEl.querySelectorAll('.notif-row').forEach((row) => {
    row.addEventListener('click', async () => {
      if (!row.classList.contains('unread')) return;
      row.classList.remove('unread');
      await window.api.server.markNotificationRead(Number(row.dataset.id));
      notifDot.hidden = !notifListEl.querySelector('.notif-row.unread');
    });
  });
}

function startNotificationPolling() {
  refreshNotifications();
  if (notifPollTimer) clearInterval(notifPollTimer);
  notifPollTimer = setInterval(refreshNotifications, 30000);
}

function stopNotificationPolling() {
  if (notifPollTimer) clearInterval(notifPollTimer);
  notifPollTimer = null;
  notifDot.hidden = true;
  notifPanel.hidden = true;
  notifListEl.innerHTML = '';
}

async function refreshTrash() {
  trashListEl.innerHTML = '<div class="muted small">Loading…</div>';
  const res = await window.api.server.getTrash(trashModalProjectId);
  if (!res.ok) {
    trashListEl.innerHTML = `<div class="muted small">Error: ${escapeHtml(res.error)}</div>`;
    return;
  }
  const items = [...res.folders, ...res.files];
  trashListEl.innerHTML =
    items
      .map(
        (item) => `
    <div class="member-row">
      <div class="member-info">
        <span class="member-name">${item.isFolder ? '&#128193;' : '&#128196;'} ${escapeHtml(item.name)}</span>
      </div>
      <div class="member-controls">
        <button class="local-tool-btn restore-btn" data-id="${item.id}" data-is-folder="${item.isFolder}">Restore</button>
      </div>
    </div>`
      )
      .join('') || '<div class="muted small">Trash is empty.</div>';

  trashListEl.querySelectorAll('.restore-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      const isFolder = btn.dataset.isFolder === 'true';
      const res2 = isFolder ? await window.api.server.restoreFolder(id) : await window.api.server.restoreFile(id);
      if (!res2.ok) {
        alert('Could not restore: ' + res2.error);
        return;
      }
      await refreshTrash();
      if (currentFolderId) await loadFolder(currentFolderId);
    });
  });
}

function openTrash(projectId) {
  trashModalProjectId = projectId;
  trashOverlay.hidden = false;
  refreshTrash();
}

// --- Manage access modal (owner/admin can invite, change roles, remove) ---

const membersOverlay = document.getElementById('members-overlay');
const membersListEl = document.getElementById('members-list');
const membersCloseBtn = document.getElementById('members-close-btn');
const membersErrorEl = document.getElementById('members-error');
const inviteForm = document.getElementById('invite-form');
const inviteEmailInput = document.getElementById('invite-email');
const inviteRoleSelect = document.getElementById('invite-role');
const syncModeSelectEl = document.getElementById('sync-mode-select');
const syncModeHintEl = document.getElementById('sync-mode-hint');

const SYNC_MODE_HINTS = {
  basic: 'Anyone can push or pull files anytime — no checkout required.',
  advisory: "Checkout is visible to everyone, but never blocks an upload — you'll just get a warning if someone else has the file checked out.",
  checkin: 'A file must be checked out before anyone can upload a new version.',
};

let membersModalProjectId = null;

function roleBadgeOrControls(m, canManage) {
  if (!canManage) return `<span class="role-badge">${escapeHtml(m.role)}</span>`;
  return `
    <select class="role-select" data-user-id="${m.userId}">
      <option value="member" ${m.role === 'member' ? 'selected' : ''}>Member</option>
      <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>Admin</option>
    </select>
    <button class="member-remove-btn" data-email="${escapeHtml(m.email)}" title="Remove">&times;</button>`;
}

async function refreshMembersList() {
  membersListEl.innerHTML = '<div class="muted small">Loading…</div>';
  const res = await window.api.server.getProjectMembers(membersModalProjectId);
  if (!res.ok) {
    membersListEl.innerHTML = `<div class="muted small">Error: ${escapeHtml(res.error)}</div>`;
    return;
  }

  const rows = [];
  if (res.owner) {
    rows.push(`
      <div class="member-row">
        <div class="member-info"><span class="member-name">${escapeHtml(res.owner.name || res.owner.email)}</span><span class="member-email">${escapeHtml(res.owner.email)}</span></div>
        <div class="member-controls"><span class="role-badge owner">Owner</span></div>
      </div>`);
  }
  for (const m of res.members) {
    rows.push(`
      <div class="member-row">
        <div class="member-info"><span class="member-name">${escapeHtml(m.name || m.email)}</span><span class="member-email">${escapeHtml(m.email)}</span></div>
        <div class="member-controls">${roleBadgeOrControls(m, res.canManage)}</div>
      </div>`);
  }
  membersListEl.innerHTML = rows.join('') || '<div class="muted small">No one else has access yet.</div>';

  inviteForm.hidden = !res.canManage;

  syncModeSelectEl.value = res.syncMode || 'checkin';
  syncModeSelectEl.disabled = !res.canManage;
  syncModeHintEl.textContent = SYNC_MODE_HINTS[res.syncMode] || '';

  membersListEl.querySelectorAll('.role-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      sel.disabled = true;
      const r = await window.api.server.updateMemberRole(membersModalProjectId, Number(sel.dataset.userId), sel.value);
      sel.disabled = false;
      if (!r.ok) {
        alert('Could not update role: ' + r.error);
        refreshMembersList();
      }
    });
  });
  membersListEl.querySelectorAll('.member-remove-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remove ${btn.dataset.email} from this project?`)) return;
      const r = await window.api.server.unshareProject(membersModalProjectId, btn.dataset.email);
      if (!r.ok) {
        alert('Could not remove: ' + r.error);
        return;
      }
      refreshMembersList();
    });
  });
}

function openMembersModal(projectId) {
  membersModalProjectId = projectId;
  membersErrorEl.textContent = '';
  inviteForm.reset();
  membersOverlay.hidden = false;
  refreshMembersList();
}

if (hasApi) {
  membersCloseBtn.addEventListener('click', () => {
    membersOverlay.hidden = true;
  });

  syncModeSelectEl.addEventListener('change', async () => {
    const newMode = syncModeSelectEl.value;
    syncModeSelectEl.disabled = true;
    const res = await window.api.server.updateProjectSyncMode(membersModalProjectId, newMode);
    syncModeSelectEl.disabled = false;
    if (!res.ok) {
      alert('Could not update sync mode: ' + res.error);
      refreshMembersList();
      return;
    }
    syncModeHintEl.textContent = SYNC_MODE_HINTS[newMode] || '';
    // Reflect it immediately if this is the project currently open behind
    // the modal, instead of waiting for the next folder navigation.
    if (membersModalProjectId === currentProjectId) {
      currentSyncMode = newMode;
      if (currentFolderId) loadFolder(currentFolderId);
    }
  });

  inviteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    membersErrorEl.textContent = '';
    const email = inviteEmailInput.value.trim();
    const role = inviteRoleSelect.value;
    const res = await window.api.server.shareProject(membersModalProjectId, email, role);
    if (!res.ok) {
      membersErrorEl.textContent = res.error;
      return;
    }
    inviteForm.reset();
    refreshMembersList();
  });

  shareProjectBtn.addEventListener('click', () => {
    if (!currentProjectId) return;
    openMembersModal(currentProjectId);
  });

  searchInputEl.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const ctx = detectOperatorContext(searchInputEl);
    if (ctx) {
      searchDebounceTimer = setTimeout(() => showSearchSuggestions(ctx), 120);
    } else {
      clearSuggestions();
    }
  });
  searchInputEl.addEventListener('keydown', (e) => {
    if (activeSuggestions.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeSuggestionIndex = Math.min(activeSuggestionIndex + 1, activeSuggestions.length - 1);
        highlightSuggestion(activeSuggestionIndex);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeSuggestionIndex = Math.max(activeSuggestionIndex - 1, 0);
        highlightSuggestion(activeSuggestionIndex);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        acceptSuggestion(activeSuggestionIndex >= 0 ? activeSuggestionIndex : 0);
        return;
      }
      if (e.key === 'Escape') {
        clearSuggestions();
        return;
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      applySearchFilter(searchInputEl.value);
      return;
    }
    if (e.key === 'Escape') {
      if (searchFilterActive) {
        searchInputEl.value = '';
        exitSearchFilter();
      }
      searchInputEl.blur();
    }
  });
  document.addEventListener('click', (e) => {
    if (!searchBoxEl.contains(e.target)) {
      clearSuggestions();
    }
  });

  trashBtn.hidden = false;
  trashBtn.addEventListener('click', () => {
    if (!currentProjectId) return;
    openTrash(currentProjectId);
  });
  trashCloseBtn.addEventListener('click', () => {
    trashOverlay.hidden = true;
  });

  settingsBtn.hidden = false;
  settingsBtn.addEventListener('click', openSettings);
  settingsCloseBtn.addEventListener('click', () => {
    settingsOverlay.hidden = true;
  });
  chooseSyncFolderBtn.addEventListener('click', async () => {
    chooseSyncFolderBtn.disabled = true;
    const res = await window.api.settings.chooseSyncFolder();
    chooseSyncFolderBtn.disabled = false;
    if (!res.ok) return;
    await refreshSyncFolderPath();
  });

  activityBtn.addEventListener('click', () => {
    if (!currentProjectId) return;
    openActivity(currentProjectId);
  });
  activityCloseBtn.addEventListener('click', () => {
    activityOverlay.hidden = true;
  });

  notifBtn.hidden = false;
  notifBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    notifPanel.hidden = !notifPanel.hidden;
    if (!notifPanel.hidden) refreshNotifications();
  });
  document.addEventListener('click', (e) => {
    if (!notifPanel.hidden && !notifPanel.contains(e.target) && e.target !== notifBtn) notifPanel.hidden = true;
  });
  notifMarkAllBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.api.server.markAllNotificationsRead();
    refreshNotifications();
  });

  newFolderBtn.addEventListener('click', async () => {
    if (!currentFolderId) return;
    const name = await showInputModal('Folder name');
    if (!name) return;
    const res = await window.api.server.createFolder(currentFolderId, name);
    if (!res.ok) {
      alert('Could not create folder: ' + res.error);
      return;
    }
    loadFolder(currentFolderId);
  });

  uploadFileBtn.addEventListener('click', async () => {
    if (!currentFolderId) return;
    const res = await window.api.server.chooseFilesToUpload();
    if (res.canceled) return;
    if (!res.ok) {
      alert('Could not open file picker: ' + res.error);
      return;
    }
    enqueueUploads(currentFolderId, res.filePaths);
  });

  uploadQueueBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    uploadQueuePanel.hidden = !uploadQueuePanel.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!uploadQueuePanel.hidden && !uploadQueueWrap.contains(e.target)) uploadQueuePanel.hidden = true;
  });

  syncStatusBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    syncStatusPanel.hidden = !syncStatusPanel.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!syncStatusPanel.hidden && !syncStatusWrap.contains(e.target)) syncStatusPanel.hidden = true;
  });
  syncUnlinkBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentProjectId) return;
    if (!confirm('Stop continuous sync for this project? Local files are left in place, but changes will no longer push or pull automatically.')) return;
    await window.api.sync.unlink(currentProjectId);
    syncStatusPanel.hidden = true;
    await refreshSyncStatus();
  });
  startSyncStatusPolling();
}

// --- Auth (top-right avatar) — Google is identity only now, everything
// else is our own server ---

const avatarEl = document.getElementById('user-avatar');
const avatarImgEl = document.getElementById('user-avatar-img');
const avatarInitialsEl = document.getElementById('user-avatar-initials');
const projectsSubtitleEl = document.querySelector('.screen-subtitle');
const signinOverlay = document.getElementById('signin-overlay');
const signinGoogleBtn = document.getElementById('signin-google-btn');
const signinErrorEl = document.getElementById('signin-error');
const signinChangeServerBtn = document.getElementById('signin-change-server-btn');

let lastProfile = null;

function setAvatarLoading() {
  avatarImgEl.hidden = true;
  avatarInitialsEl.hidden = false;
  avatarInitialsEl.textContent = '…';
}

function renderAuthState(state) {
  if (state.signedIn) {
    lastProfile = state.profile;
    if (state.profile?.avatarUrl) {
      avatarImgEl.src = state.profile.avatarUrl;
      avatarImgEl.hidden = false;
      avatarInitialsEl.hidden = true;
    } else {
      avatarImgEl.hidden = true;
      avatarInitialsEl.hidden = false;
      avatarInitialsEl.textContent = initialsOf(state.profile?.name || state.profile?.email || '');
    }
    avatarEl.title = (state.profile?.email || '') + ' — click to sign out';
    avatarEl.classList.remove('signed-out');
    projectsSubtitleEl.textContent = 'Signed in as ' + (state.profile?.email || 'unknown');
    signinOverlay.hidden = true;
    showNoProjectSelected();
    loadProjects();
    if (hasApi) startNotificationPolling();
  } else {
    lastProfile = null;
    if (hasApi) stopNotificationPolling();
    avatarImgEl.hidden = true;
    avatarInitialsEl.hidden = false;
    avatarInitialsEl.textContent = '?';
    avatarEl.title = 'Sign in with Google';
    avatarEl.classList.add('signed-out');
    projectsSubtitleEl.textContent = 'Sign in with Google to sync your real projects';
    // The user should be prompted to sign in before doing anything else —
    // demo mode is the one deliberate exception, since it has no server
    // (and therefore no account) to sign in to.
    if (hasApi && !demoMode) signinOverlay.hidden = false;
    showSignedOutBrowser();
    loadProjects();
  }
}

let signedIn = false;

async function refreshAuthStatus() {
  const state = await window.api.auth.status();
  signedIn = state.signedIn;
  renderAuthState(state);
}

async function doSignIn(errorEl) {
  setAvatarLoading();
  const res = await window.api.auth.signIn();
  if (res.ok) {
    signedIn = true;
    signinChangeServerBtn.hidden = true;
    renderAuthState({ signedIn: true, profile: res.profile });
  } else {
    signedIn = false;
    renderAuthState({ signedIn: false });
    if (errorEl) {
      errorEl.textContent = res.error;
      // A failed sign-in is often not a bad password/account — it's the
      // server having moved (new LAN IP, DHCP lease renewal) since this
      // address was saved. Surface the fix right where the failure appears
      // instead of making them dig through Settings.
      signinChangeServerBtn.hidden = false;
    } else {
      alert('Sign-in failed: ' + res.error);
    }
  }
}

if (hasApi) {
  avatarEl.addEventListener('click', async () => {
    if (signedIn) {
      await window.api.auth.signOut();
      signedIn = false;
      renderAuthState({ signedIn: false });
      return;
    }
    doSignIn(null);
  });

  signinGoogleBtn.addEventListener('click', async () => {
    signinGoogleBtn.disabled = true;
    signinErrorEl.textContent = '';
    signinChangeServerBtn.hidden = true;
    await doSignIn(signinErrorEl);
    signinGoogleBtn.disabled = false;
  });
} else {
  avatarEl.title = 'Desktop app only';
  avatarEl.classList.add('signed-out');
  showSignedOutBrowser();
}

// --- Connect-to-server gate ---

const connectOverlay = document.getElementById('connect-overlay');
const serverUrlInput = document.getElementById('server-url-input');
const connectBtn = document.getElementById('connect-btn');
const connectErrorEl = document.getElementById('connect-error');
const trustNewCertBtn = document.getElementById('trust-new-cert-btn');
const demoModeBtn = document.getElementById('demo-mode-btn');
const demoModeBannerEl = document.getElementById('demo-mode-banner');
const connectFromDemoBtn = document.getElementById('connect-from-demo-btn');

// Demo mode: skip the server entirely and go straight to the Browser
// screen's local-file preview, which already works standalone (see
// "Local file testing affordances" below). Server-only actions
// (share/upload/new folder — all no-ops without a project anyway) are
// hidden to avoid implying they'll do something.
function enterDemoMode() {
  demoMode = true;
  connectOverlay.hidden = true;
  demoModeBannerEl.hidden = false;
  shareProjectBtn.hidden = true;
  newFolderBtn.hidden = true;
  uploadFileBtn.hidden = true;
  showDemoModeBrowser();
  switchScreen('browser');
}

function exitDemoMode() {
  demoMode = false;
  demoModeBannerEl.hidden = true;
  shareProjectBtn.hidden = false;
  newFolderBtn.hidden = false;
  uploadFileBtn.hidden = false;
}

// Reopens the connect gate on demand — used when the saved server address
// has gone stale (LAN IP changed, DHCP lease renewed) rather than only on
// first launch. Pre-fills the current address so the user is editing it,
// not starting from scratch.
async function openConnectOverlay() {
  signinOverlay.hidden = true;
  settingsOverlay.hidden = true;
  connectErrorEl.textContent = '';
  trustNewCertBtn.hidden = true;
  const res = await window.api.settings.getServerUrl();
  serverUrlInput.value = res.serverUrl || '';
  connectOverlay.hidden = false;
  serverUrlInput.focus();
}

async function tryConnect() {
  const url = serverUrlInput.value.trim();
  if (!url) return;
  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting…';
  connectErrorEl.textContent = '';
  trustNewCertBtn.hidden = true;
  const res = await window.api.settings.setServerUrl(url);
  connectBtn.disabled = false;
  connectBtn.textContent = 'Connect';
  if (res.ok) {
    connectOverlay.hidden = true;
    exitDemoMode();
    refreshAuthStatus();
  } else {
    connectErrorEl.textContent = res.error;
    trustNewCertBtn.hidden = !res.certMismatch;
  }
}

if (hasApi) {
  connectBtn.addEventListener('click', tryConnect);
  serverUrlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') tryConnect();
  });
  demoModeBtn.addEventListener('click', enterDemoMode);
  connectFromDemoBtn.addEventListener('click', () => {
    connectOverlay.hidden = false;
  });
  trustNewCertBtn.addEventListener('click', async () => {
    trustNewCertBtn.hidden = true;
    connectErrorEl.textContent = '';
    await window.api.settings.forgetCertificate(serverUrlInput.value.trim());
    tryConnect();
  });
  settingsChangeServerBtn.addEventListener('click', openConnectOverlay);
  signinChangeServerBtn.addEventListener('click', openConnectOverlay);
}

async function initConnection() {
  if (!hasApi) return;
  const res = await window.api.settings.getServerUrl();
  if (res.serverUrl) {
    serverUrlInput.value = res.serverUrl;
    connectOverlay.hidden = true;
    refreshAuthStatus();
  } else {
    connectOverlay.hidden = false;
  }
}

// --- Init ---

loadProjects();
switchScreen('projects');
renderFileDetails(null);
initConnection();
