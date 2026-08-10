const fs = require('fs');
const path = require('path');
const { findBlobs } = require('./sldprt');

// JS port of sldprt-parser's assembly.py (component/matrix resolution) and
// bom.py (BOM walk/rollup/CSV) — see that project's docstrings for the
// underlying format reasoning. This only ports what a BOM needs: component
// *names* and their file resolution, not geometry/placement, so the matrix
// math here exists purely to find each instance's record boundary in the
// blob, never to place anything in space.

const VIEW_NAME_RE = /^\*/; // *Front, *Isometric, ... are named views, not parts
const INST_SUFFIX_RE = /-\d+$/;

// Scene furniture and view/display entries are stored as "-N" instances too,
// so they look exactly like components until excluded by name.
const NOT_A_PART_RE = /^(ambient|directional|spot|point|light|camera|scene|display state|annotations|lights and cameras|sensors|equations|history|favorites|selection sets|design binder|comments|surface bodies|solid bodies|material|sketch|plane|origin|axis)\b/i;

// UTF-16LE text scan with byte positions — SolidWorks stores strings this
// way; an ASCII scan finds almost nothing. Matching on the blob's latin1
// decoding treats each byte as one char 1:1, so match.index is a real byte
// offset — the actual decode then re-reads that byte range as utf16le.
function utf16StringsWithPos(buf) {
  const latin1 = buf.toString('latin1');
  const re = /(?:[\x20-\x7e]\x00){4,}/g;
  const out = [];
  let m;
  while ((m = re.exec(latin1))) {
    out.push([m.index, buf.toString('utf16le', m.index, m.index + m[0].length)]);
  }
  return out;
}
function utf16Strings(buf) {
  return utf16StringsWithPos(buf).map(([, s]) => s);
}

function orthonormal(m) {
  for (let r = 0; r < 3; r++) {
    const sum = m[r * 3] ** 2 + m[r * 3 + 1] ** 2 + m[r * 3 + 2] ** 2;
    if (Math.abs(Math.sqrt(sum) - 1) >= 1e-9) return false;
  }
  return true;
}

// findBlobs is the expensive part of everything here (a candidate deflate
// stream attempt at nearly every byte offset) — measured at ~300ms even for
// a modest ~135KB part file. readComponents wants blobs >= 2048 bytes,
// partMeta wants >= 1024; scanning once at the smaller/superset threshold
// and filtering in memory for the pickier caller means a file's bytes only
// ever get decompressed-and-scanned once, cached per absolute path, even
// though an assembly-type row needs both its own components (readComponents)
// and its own metadata (partMeta) — previously two full scans of the same
// file. Measured ~22% faster on a real 11-row assembly (7.1s -> 5.5s); the
// gain scales with how many rows are themselves subassemblies, since those
// were the ones paying for two scans — plain parts were always scanned once.
function getFileBlobs(filePath, blobCache) {
  if (blobCache.has(filePath)) return blobCache.get(filePath);
  const raw = fs.readFileSync(filePath);
  const blobs = findBlobs(raw, 1024);
  blobCache.set(filePath, blobs);
  return blobs;
}

// [[instanceName, R(9), t(3)], ...] for one assembly file. Several blobs
// carry orthonormal matrices next to names (the mate blob especially), so
// this scores every candidate blob by how many instance names actually
// resolve to real component files and keeps the best-scoring one.
function readComponents(filePath, idx, ground = true, keepUnresolved = false, blobCache = new Map()) {
  const IDENT = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const ORIGIN = [0, 0, 0];
  let best = [];
  let bestScore = -1;

  const blobs = getFileBlobs(filePath, blobCache).filter((b) => b.data.length >= 2048);
  for (const { data: B } of blobs) {
    const S = utf16StringsWithPos(B);
    if (!S.length) continue;

    const anchors = [];
    const seen = new Set();
    let resolvable = 0;
    for (const [p, sRaw] of S) {
      const s = sRaw.trim();
      if (s.includes('@') || VIEW_NAME_RE.test(s)) continue;
      const m = s.match(/^(.*-\d+)/);
      if (!m) continue;
      const nm = m[1];
      if (seen.has(nm)) continue;
      const known = idx == null || !!idx.get(nm.replace(INST_SUFFIX_RE, '').trim().toLowerCase());
      // a BOM wants every instance listed, including ones whose file is
      // missing; the renderer (not ported here) only wants loadable ones
      if (!known && !keepUnresolved) continue;
      resolvable += known ? 1 : 0;
      seen.add(nm);
      anchors.push([p, nm]);
    }
    if (!anchors.length) continue;

    // Scans every byte offset in the blob (SolidWorks doesn't align these
    // records), so the inner check runs millions of times on a large blob —
    // measured as the dominant remaining cost after the findBlobs fix
    // (V8 profiler: ~35% of total time here). The scratch buffer is reused
    // across all of them rather than allocating a fresh array per offset
    // (99%+ of which bail on the very first double); a real 9-element array
    // is only ever built for a confirmed match, which is rare.
    // A matrix match is only ever looked up inside an anchor's own span —
    // `bounds[0]` is anchors[0][0], so nothing before the first anchor can
    // ever satisfy `p <= x[0]` for any anchor (anchors are position-sorted,
    // since S/utf16StringsWithPos yields matches in increasing offset
    // order). Starting the scan there instead of at 0 skips a region whose
    // matches could never be used anyway.
    const mats = [];
    const scratch = new Float64Array(9);
    let q = anchors[0][0];
    while (q < B.length - 104) {
      let bad = false;
      for (let k = 0; k < 9; k++) {
        const v = B.readDoubleLE(q + k * 8);
        if (Math.abs(v) > 1.0001) {
          bad = true;
          break;
        }
        scratch[k] = v;
      }
      if (!bad && orthonormal(scratch)) {
        const t = [B.readDoubleLE(q + 72), B.readDoubleLE(q + 80), B.readDoubleLE(q + 88)];
        const sc = B.readDoubleLE(q + 96);
        if (t.every((x) => Math.abs(x) < 5.0) && Math.abs(sc - 1.0) < 1e-6) {
          mats.push([q, Array.from(scratch), t]);
          q += 104;
          continue;
        }
      }
      q += 1;
    }

    // Pair each instance with the first transform inside ITS OWN record
    // span — span-bounded beats "nearest preceding string" because it can
    // tell a genuinely transform-less (grounded) component from one that
    // just sits far from its matrix.
    const bounds = anchors.map(([p]) => p).concat([B.length]);
    const entries = [];
    let withT = 0;
    for (let i = 0; i < anchors.length; i++) {
      const [p, nm] = anchors[i];
      const span = mats.find((x) => p <= x[0] && x[0] < bounds[i + 1]);
      if (span) {
        entries.push([nm, span[1], span[2]]);
        withT += 1;
      } else if (ground) {
        // SolidWorks fixes/grounds components (the first one especially)
        // with no matrix stored at all; those belong at the origin.
        entries.push([nm, IDENT, ORIGIN]);
      }
    }
    const score = keepUnresolved ? Math.min(withT, resolvable) : withT;
    if (score > bestScore) {
      best = entries;
      bestScore = score;
    }
  }
  return best;
}

// Indexes component files, searching `levels` directories above `root` too.
// Assemblies routinely sit in a subfolder while shared/vendor parts live
// beside it in the project tree, so indexing only the assembly's own folder
// loses most of them. Falls back to the narrow root if a parent turns out
// to be enormous.
function indexFiles(root, levels = 1, cap = 60000) {
  const start = path.resolve(root);
  let top = start;
  for (let i = 0; i < Math.max(0, levels); i++) {
    const parent = path.dirname(top);
    if (parent === top) break;
    top = parent;
  }

  function walkDir(base) {
    const idx = new Map();
    function recurse(dir) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return true;
      }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          if (!recurse(full)) return false;
        } else if (ent.isFile()) {
          const lower = ent.name.toLowerCase();
          if ((lower.endsWith('.sldprt') || lower.endsWith('.sldasm')) && !ent.name.startsWith('~$')) {
            const key = path.parse(ent.name).name.toLowerCase();
            if (!idx.has(key)) idx.set(key, full);
            if (idx.size > cap) return false;
          }
        }
      }
      return true;
    }
    return recurse(base) ? idx : null;
  }

  return walkDir(top) || walkDir(start) || new Map();
}

function isComponent(name) {
  if (name.length < 3 || NOT_A_PART_RE.test(name)) return false;
  // absolute paths leak into the string pool; a component name is never one
  return !/[\\/]|^[A-Za-z]:/.test(name);
}

// Strip the "-N" instance suffix, but only when that actually helps. Vendor
// part numbers end in digits too ("WCP-1458", "TTB-0241"), so blind
// stripping turns them into "WCP" and "TTB". Prefer whichever form names a
// real file, and keep the full name when neither does.
function baseName(nmRaw, idx) {
  const nm = nmRaw.split('@')[0].trim();
  if (idx.get(nm.toLowerCase())) return nm;
  const stripped = nm.replace(INST_SUFFIX_RE, '').trim();
  if (idx.get(stripped.toLowerCase())) return stripped;
  if (/\.(step|stp|sldprt|sldasm|igs|iges|x_t)$/i.test(stripped)) return stripped;
  return nm;
}

// [part_number, description, material] read from a part/assembly file.
function partMeta(filePath, metaCache, blobCache = new Map()) {
  if (metaCache.has(filePath)) return metaCache.get(filePath);
  let pn = '';
  let desc = '';
  let mat = '';
  try {
    for (const { data: b } of getFileBlobs(filePath, blobCache)) {
      const i = b.indexOf('<?xml');
      if (i >= 0 && b.subarray(i, Math.min(i + 4000, b.length)).includes('Properties')) {
        const xml = b.toString('utf8', i);
        const propRe = /<property name="([^"]*)"[^>]*>([\s\S]*?)<\/property>/g;
        let m;
        while ((m = propRe.exec(xml))) {
          const txt = m[2].replace(/<[^>]+>/g, '').trim();
          if (!txt) continue;
          const low = m[1].toLowerCase();
          if (low.includes('bom part number') || low === 'partno' || low === 'part number') {
            pn = pn || txt;
          } else if (low === 'description' || low === 'sw-description') {
            desc = desc || txt;
          }
        }
      }
      for (const s of utf16Strings(b)) {
        if (s.startsWith('Material <') && !mat) {
          mat = s.slice('Material <'.length).replace(/>+$/, '');
        } else if (s.startsWith('SW-Material') && !mat) {
          mat = s;
        }
      }
    }
  } catch {
    // matches the Python original's bare except: fall back to blanks
  }
  const result = [pn, desc, mat];
  metaCache.set(filePath, result);
  return result;
}

// One row per component instance, recursing into subassemblies
// (multiplying quantities through). `metaCache`/`blobCache` are scoped to
// a single generateBOM() call, not module-level — a long-lived Electron
// process must not serve stale part data across separate BOM runs.
function walkAssembly(filePath, idx, metaCache, blobCache, depth = 0, seen = null) {
  const key = path.resolve(filePath).toLowerCase();
  seen = seen || new Set();
  if (seen.has(key)) return []; // circular reference guard
  const seenNext = new Set(seen);
  seenNext.add(key);

  const comps = readComponents(filePath, idx, true, true, blobCache);
  const counts = new Map();
  for (const [nm] of comps) {
    const base = baseName(nm, idx);
    if (!isComponent(base)) continue;
    counts.set(base, (counts.get(base) || 0) + 1);
  }

  const out = [];
  for (const [base, qty] of counts) {
    const f = idx.get(base.toLowerCase());
    const kind = f ? (f.toLowerCase().endsWith('.sldasm') ? 'assembly' : 'part') : 'missing';
    const [pn, desc, mat] = f ? partMeta(f, metaCache, blobCache) : ['', '', ''];
    out.push({ depth, name: base, qty, kind, part_number: pn, description: desc, material: mat, file: f || '' });
    if (kind === 'assembly' && depth < 4) {
      for (const sub of walkAssembly(f, idx, metaCache, blobCache, depth + 1, seenNext)) {
        out.push({ ...sub, qty: sub.qty * qty });
      }
    }
  }
  return out;
}

// Flat BOM: one line per distinct part, quantities summed, parts only.
function rollup(rows) {
  const agg = new Map();
  for (const r of rows) {
    if (r.kind === 'assembly') continue;
    if (agg.has(r.name)) agg.get(r.name).qty += r.qty;
    else agg.set(r.name, { ...r });
  }
  return [...agg.values()].sort((a, b) => b.qty - a.qty || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
}

const CSV_COLUMNS = ['qty', 'name', 'kind', 'part_number', 'description', 'material', 'file'];

function csvField(val) {
  const s = val == null ? '' : String(val);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Matches Python's csv module (CRLF rows) opened as utf-8-sig (leading BOM)
// — the exact format the client's BOM-detection/table view expects.
function toCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) lines.push(CSV_COLUMNS.map((c) => csvField(r[c])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// `levels` — how many directories above the assembly to search for
// components; pass however many levels separate it from the project's
// sync root so the whole project tree gets indexed.
function generateBOM(assemblyPath, { levels = 1 } = {}) {
  const idx = indexFiles(path.dirname(path.resolve(assemblyPath)), levels);
  const metaCache = new Map();
  const blobCache = new Map();
  const rows = walkAssembly(assemblyPath, idx, metaCache, blobCache);
  if (!rows.length) throw new Error('No components found — is this a real assembly with at least one component?');
  const out = rollup(rows);
  return { rows: out, csv: toCsv(out) };
}

module.exports = { generateBOM, indexFiles, readComponents, baseName, isComponent, rollup, toCsv };
