const fs = require('fs');
const path = require('path');
const { HDR, findBlobs } = require('./sldprt');

// Port of sldprt-parser/colors.py's face_colors()/p2m_color() — see that
// file's docstrings for the full reasoning. Summary: a SolidWorks part
// stores only the *name* of each face's appearance (e.g.
// "greenlowglossplastic") plus the path of its .p2m, embedded inside the
// byte range of the tessellation record for the face it applies to. The
// actual RGB lives in a "col1" line inside that .p2m file, which ships
// with SolidWorks itself — so this only resolves real colours on a machine
// that has SolidWorks installed; everywhere else every face silently falls
// back to DEFAULT_COLOR, same as before this feature existed.
const SW_DATA = 'C:\\Program Files\\SOLIDWORKS Corp\\SOLIDWORKS\\data';

// Matches renderer/viewer.js's plain default material color (0x9db8d6), so
// a part with no assigned appearance renders identically to before.
const DEFAULT_COLOR = [0x9d / 255, 0xb8 / 255, 0xd6 / 255];

// SolidWorks stores text as UTF-16LE; scanning a Buffer converted to
// 'latin1' (a 1:1 byte<->char mapping) lets a normal string regex find the
// runs, then the matched byte range is re-decoded properly as utf16le.
function readUtf16Strings(blob, minlen = 4) {
  const latin1 = blob.toString('latin1');
  const re = new RegExp(`(?:[\\x20-\\x7e]\\x00){${minlen},}`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(latin1))) {
    out.push({ offset: m.index, text: blob.subarray(m.index, m.index + m[0].length).toString('utf16le') });
  }
  return out;
}

// Diffuse colour of a named SolidWorks appearance. `cache` is per-call
// (one decode), not global — appearance names aren't guaranteed stable
// across unrelated files.
function p2mColor(name, hintPaths, cache) {
  if (cache.has(name)) return cache.get(name);
  const key = name.replace(/ /g, '').toLowerCase();
  const candidates = [];

  // A hint only counts if it's the .p2m for THIS appearance — otherwise
  // every appearance resolves to whichever path happened to come first.
  for (const h of hintPaths) {
    const stem = path.win32.basename(h).replace(/ /g, '').toLowerCase();
    if (stem.endsWith('.p2m') && stem.slice(0, -4) === key) {
      candidates.push(h.replace('<SystemTexture>', path.win32.join(SW_DATA, 'graphics')));
    }
  }

  const materialsDir = path.win32.join(SW_DATA, 'graphics', 'materials');
  try {
    for (const entry of fs.readdirSync(materialsDir, { recursive: true })) {
      const base = path.win32.basename(entry);
      const lower = base.toLowerCase();
      if (lower.endsWith('.p2m') && lower.replace(/ /g, '').slice(0, -4) === key) {
        candidates.push(path.win32.join(materialsDir, entry));
      }
    }
  } catch {
    // No SolidWorks install (or no read access) — fall through with
    // whatever hint-based candidates were found, usually none.
  }

  for (const c of candidates) {
    let txt;
    try {
      txt = fs.readFileSync(c, 'latin1');
    } catch {
      continue;
    }
    const m = /"col1"\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/.exec(txt);
    if (m) {
      const rgb = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])];
      cache.set(name, rgb);
      return rgb;
    }
  }
  cache.set(name, null);
  return null;
}

// One RGB per face, in the same order as `spans` (from sldprt.js's
// decodeTess/flattenMesh). Appearance records are embedded *inside* the
// face record they apply to, so a marker is matched to the face whose byte
// range contains it. Faces with no marker of their own inherit the
// document default — the appearance declared ahead of the first face.
function faceColors(buffer, spans, defaultColor = DEFAULT_COLOR) {
  if (!spans.length) return [];
  const first = spans[0][2];

  // Only the first blob containing tessellation records is scanned for
  // strings — matches colors.py's face_colors, which assumes the
  // appearance names live alongside the geometry they colour.
  let strings = [];
  let p2mPaths = [];
  for (const { data: blob } of findBlobs(buffer)) {
    if (blob.indexOf(HDR) === -1) continue;
    for (const { offset, text } of readUtf16Strings(blob)) {
      if (text.toLowerCase().endsWith('.p2m')) p2mPaths.push({ offset, text });
      else strings.push({ offset, text });
    }
    break;
  }

  // An appearance name counts only if the file also references a .p2m of
  // that name — without this, the bare category word "plastic" (which
  // follows every appearance record) is mistaken for one and wipes out
  // the document default.
  const valid = new Set(p2mPaths.map(({ text }) => path.win32.basename(text).replace(/ /g, '').toLowerCase().slice(0, -4)));
  let doc = null;
  const marks = [];
  for (const { offset, text } of strings) {
    if (!valid.has(text.replace(/ /g, '').toLowerCase())) continue;
    if (offset < first) doc = text;
    else marks.push({ offset, text });
  }

  const bounds = spans.map((s) => s[2]).concat([Infinity]);
  const hintTexts = p2mPaths.map((p) => p.text);
  const cache = new Map();
  const out = [];
  for (let i = 0; i < spans.length; i++) {
    let name = doc;
    for (const { offset, text } of marks) {
      if (bounds[i] <= offset && offset < bounds[i + 1]) {
        name = text;
        break;
      }
    }
    const rgb = name ? p2mColor(name, hintTexts, cache) : null;
    out.push(rgb || defaultColor);
  }
  return out;
}

// Expands per-face colours to a per-vertex RGB Float32Array, so the whole
// part paints in one draw call (three.js vertexColors attribute) instead
// of one material per face. `hasColor` is false when every face resolved
// to the default — callers can skip the vertex-colour attribute entirely
// in that case and render exactly as before this feature existed.
function vertexColorsFromSpans(buffer, spans, vertexCount, defaultColor = DEFAULT_COLOR) {
  const colors = faceColors(buffer, spans, defaultColor);
  const array = new Float32Array(vertexCount * 3);
  let hasColor = false;
  for (let i = 0; i < spans.length; i++) {
    const [start, count] = spans[i];
    const [r, g, b] = colors[i];
    if (r !== defaultColor[0] || g !== defaultColor[1] || b !== defaultColor[2]) hasColor = true;
    const end = Math.min(start + count, vertexCount);
    for (let k = start; k < end; k++) {
      array[k * 3] = r;
      array[k * 3 + 1] = g;
      array[k * 3 + 2] = b;
    }
  }
  return { array, hasColor };
}

module.exports = { DEFAULT_COLOR, faceColors, p2mColor, vertexColorsFromSpans };
