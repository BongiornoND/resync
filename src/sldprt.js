const fs = require('fs');
const zlib = require('zlib');

// elem_size=12, tag=100, flag=2 — header preceding every vertex/normal
// tessellation record. See sldprt-parser/README.md for the full format
// writeup; this is a straight port of that project's sldprt.py.
const HDR = Buffer.from([0x0c, 0, 0, 0, 0x64, 0, 0, 0, 0x02, 0, 0, 0]);

// Brute-force locates every raw-deflate stream in the file. SLDPRT has no
// index/table of contents pointing at its payload blobs, so this is the only
// way in — but each candidate offset that isn't real deflate data fails
// almost immediately, so it's tractable for the file sizes involved (low
// hundreds of KB to a few MB).
function findBlobs(raw, minOut = 2048) {
  const n = raw.length;
  const blobs = [];
  let off = 0;
  while (off < n - 4) {
    let result;
    try {
      result = zlib.inflateRawSync(raw.subarray(off), { info: true });
    } catch {
      off += 1;
      continue;
    }
    const full = result.buffer;
    if (full.length >= minOut) {
      blobs.push({ offset: off, data: full });
      off += Math.max(result.engine.bytesWritten, 1);
    } else {
      off += 1;
    }
  }
  return blobs;
}

// Decodes triangle-strip tessellation records out of one decompressed blob.
// Returns { verts, norms, tris, faces } — verts/norms are arrays of [x,y,z],
// tris are arrays of [a,b,c] vertex indices.
function decodeTess(blob) {
  const N = blob.length;
  const verts = [];
  const norms = [];
  const tris = [];
  const used = new Set();
  let pos = 0;
  let faces = 0;

  while (true) {
    const i = blob.indexOf(HDR, pos);
    if (i === -1) break;
    pos = i + 1;
    if (used.has(i)) continue;

    const cnt = blob.readUInt32LE(i + 12);
    if (!(cnt > 0 && cnt < 2_000_000 && i + 16 + cnt * 12 <= N)) continue;

    const npos = i + 16 + cnt * 12;
    if (npos + 16 > N) continue;
    const e2 = blob.readUInt32LE(npos);
    const t2 = blob.readUInt32LE(npos + 4);
    const c2 = blob.readUInt32LE(npos + 12);
    if (!(e2 === 12 && t2 === 100 && c2 === cnt)) continue;

    // The second [12,100,2,cnt] record must actually be unit normals —
    // otherwise this is a coincidental header match, not real geometry.
    const chk = Math.min(cnt, 24);
    let ok = 0;
    for (let k = 0; k < chk; k++) {
      const base = npos + 16 + k * 12;
      const x = blob.readFloatLE(base);
      const y = blob.readFloatLE(base + 4);
      const z = blob.readFloatLE(base + 8);
      if (Math.abs(Math.sqrt(x * x + y * y + z * z) - 1.0) < 0.02) ok++;
    }
    if (ok < chk * 0.8) continue;

    used.add(npos);
    let p = npos + 16 + cnt * 12;
    const arrs = [];
    while (p + 16 <= N && arrs.length < 3) {
      const e3 = blob.readUInt32LE(p);
      const t3 = blob.readUInt32LE(p + 4);
      const c3 = blob.readUInt32LE(p + 12);
      if (t3 !== 8 || ![1, 2, 4].includes(e3) || c3 === 0 || p + 16 + e3 * c3 > N) break;
      arrs.push({ elem: e3, count: c3, offset: p + 16 });
      p += 16 + e3 * c3;
    }
    if (arrs.length < 2 || arrs[1].elem !== 4) continue;

    const V = new Array(cnt);
    const Nm = new Array(cnt);
    for (let k = 0; k < cnt; k++) {
      const vb = i + 16 + k * 12;
      const nb = npos + 16 + k * 12;
      V[k] = [blob.readFloatLE(vb), blob.readFloatLE(vb + 4), blob.readFloatLE(vb + 8)];
      Nm[k] = [blob.readFloatLE(nb), blob.readFloatLE(nb + 4), blob.readFloatLE(nb + 8)];
    }

    const { count: cB, offset: oB } = arrs[1];
    const B = new Array(cB);
    for (let k = 0; k < cB; k++) B[k] = blob.readUInt32LE(oB + k * 4);
    const lens = B.map((b) => Math.floor(b / 2) + 1);
    if (lens.reduce((a, b) => a + b, 0) !== cnt) continue;

    // Vertex array is a plain concatenation of triangle strips, one per
    // face. Walk each strip with standard alternating winding, flipping
    // when the geometric normal opposes the stored vertex normal.
    const base = verts.length;
    for (const v of V) verts.push(v);
    for (const nv of Nm) norms.push(nv);

    let q = 0;
    for (const L of lens) {
      const seg = [];
      for (let s = 0; s < L; s++) seg.push(base + q + s);
      q += L;
      for (let m = 0; m <= L - 3; m++) {
        let a, b, c;
        if (m % 2 === 0) {
          a = seg[m]; b = seg[m + 1]; c = seg[m + 2];
        } else {
          a = seg[m + 1]; b = seg[m]; c = seg[m + 2];
        }
        const [ax, ay, az] = verts[a];
        const [bx, by, bz] = verts[b];
        const [cx, cy, cz] = verts[c];
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const wx = cx - ax, wy = cy - ay, wz = cz - az;
        const nx = uy * wz - uz * wy;
        const ny = uz * wx - ux * wz;
        const nz = ux * wy - uy * wx;
        if (nx * nx + ny * ny + nz * nz < 1e-30) continue;
        const [sx, sy, sz] = norms[a];
        if (nx * sx + ny * sy + nz * sz < 0) {
          const t = a; a = b; b = t;
        }
        tris.push([a, b, c]);
      }
    }
    faces += 1;
  }

  return { verts, norms, tris, faces };
}

function decodeBuffer(raw) {
  let best = null;
  for (const { data } of findBlobs(raw)) {
    const result = decodeTess(data);
    if (result.tris.length && (!best || result.tris.length > best.tris.length)) {
      best = result;
    }
  }
  if (!best) throw new Error('No tessellation data found');
  return best;
}

function load(filePath) {
  try {
    return decodeBuffer(fs.readFileSync(filePath));
  } catch (err) {
    if (err.message === 'No tessellation data found') throw new Error('No tessellation data found in ' + filePath);
    throw err;
  }
}

// Flattens a decoded mesh into typed arrays ready for a three.js
// BufferGeometry (position/normal attributes + a triangle index buffer).
function flattenMesh({ verts, norms, tris, faces }) {
  const positions = new Float32Array(verts.length * 3);
  const normals = new Float32Array(norms.length * 3);
  for (let i = 0; i < verts.length; i++) {
    positions[i * 3] = verts[i][0];
    positions[i * 3 + 1] = verts[i][1];
    positions[i * 3 + 2] = verts[i][2];
    normals[i * 3] = norms[i][0];
    normals[i * 3 + 1] = norms[i][1];
    normals[i * 3 + 2] = norms[i][2];
  }

  const IndexArray = verts.length > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexArray(tris.length * 3);
  for (let i = 0; i < tris.length; i++) {
    indices[i * 3] = tris[i][0];
    indices[i * 3 + 1] = tris[i][1];
    indices[i * 3 + 2] = tris[i][2];
  }

  return {
    positions,
    normals,
    indices,
    vertexCount: verts.length,
    triangleCount: tris.length,
    faceCount: faces,
  };
}

function loadMesh(filePath) {
  return flattenMesh(load(filePath));
}

function loadMeshFromBuffer(buffer) {
  return flattenMesh(decodeBuffer(buffer));
}

module.exports = { findBlobs, decodeTess, decodeBuffer, load, loadMesh, loadMeshFromBuffer };
