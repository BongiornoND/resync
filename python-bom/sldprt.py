"""Generic SolidWorks .SLDPRT / .SLDASM tessellation extractor.

No hardcoded offsets: brute-force locates every raw-deflate blob, then decodes
any graphics-tessellation records found inside. Assemblies cache the geometry of
all their components in world coordinates, so they decode without ever opening
the referenced part files.
"""
import struct, zlib, math, re

HDR = b'\x0c\x00\x00\x00\x64\x00\x00\x00\x02\x00\x00\x00'   # elem=12 tag=100 flag=2


def find_blobs(raw, min_out=2048):
    """Yield (offset, decompressed_bytes) for every raw-deflate stream."""
    n, off, out = len(raw), 0, []
    while off < n - 4:
        try:
            d = zlib.decompressobj(-15)
            probe = d.decompress(raw[off:off + 65536], 200000)
        except zlib.error:
            off += 1
            continue
        if len(probe) < 512:
            off += 1
            continue
        try:
            d2 = zlib.decompressobj(-15)
            full = d2.decompress(raw[off:], 80_000_000)
        except zlib.error:
            off += 1
            continue
        if len(full) >= min_out:
            consumed = len(raw) - off - len(d2.unused_data)
            out.append((off, full))
            off += max(consumed, 1)          # skip past this stream
        else:
            off += 1
    return out


def decode_tess(blob):
    """Decode triangle-strip tessellation records.

    Returns (verts, norms, tris, faces, spans) where spans is one
    (vertex_start, vertex_count, blob_offset) per face -- the blob offset lets
    callers attach per-face data such as appearances.
    """
    N = len(blob)
    verts, norms, tris, spans = [], [], [], []
    pos, used, faces = 0, set(), 0
    while True:
        i = blob.find(HDR, pos)
        if i == -1:
            break
        pos = i + 1
        if i in used:
            continue
        _, _, _, cnt = struct.unpack_from('<4I', blob, i)
        if not (0 < cnt < 2_000_000 and i + 16 + cnt * 12 <= N):
            continue
        npos = i + 16 + cnt * 12
        if npos + 16 > N:
            continue
        e2, t2, _, c2 = struct.unpack_from('<4I', blob, npos)
        if not (e2 == 12 and t2 == 100 and c2 == cnt):
            continue

        # normals array must actually be unit-length
        chk = min(cnt, 24)
        ok = 0
        for k in range(chk):
            x, y, z = struct.unpack_from('<fff', blob, npos + 16 + k * 12)
            if abs(math.sqrt(x*x + y*y + z*z) - 1.0) < 0.02:
                ok += 1
        if ok < chk * 0.8:
            continue

        used.add(npos)
        p = npos + 16 + cnt * 12
        arrs = []
        while p + 16 <= N and len(arrs) < 3:
            e3, t3, _, c3 = struct.unpack_from('<4I', blob, p)
            if t3 != 8 or e3 not in (1, 2, 4) or c3 == 0 or p + 16 + e3 * c3 > N:
                break
            arrs.append((e3, c3, p + 16))
            p += 16 + e3 * c3
        if len(arrs) < 2 or arrs[1][0] != 4:
            continue

        V = [struct.unpack_from('<fff', blob, i + 16 + k * 12) for k in range(cnt)]
        Nm = [struct.unpack_from('<fff', blob, npos + 16 + k * 12) for k in range(cnt)]
        _, cB, oB = arrs[1]
        B = struct.unpack_from(f'<{cB}I', blob, oB)
        lens = [b // 2 + 1 for b in B]
        if sum(lens) != cnt:
            continue

        base = len(verts)
        spans.append((base, cnt, i))
        verts.extend(V)
        norms.extend(Nm)
        q = 0
        for L in lens:
            seg = range(base + q, base + q + L)
            seg = list(seg)
            q += L
            for m in range(L - 2):
                a, b, c = (seg[m], seg[m+1], seg[m+2]) if m % 2 == 0 else (seg[m+1], seg[m], seg[m+2])
                ax, ay, az = verts[a]; bx, by, bz = verts[b]; cx, cy, cz = verts[c]
                ux, uy, uz = bx-ax, by-ay, bz-az
                wx, wy, wz = cx-ax, cy-ay, cz-az
                nx, ny, nz = uy*wz-uz*wy, uz*wx-ux*wz, ux*wy-uy*wx
                if nx*nx + ny*ny + nz*nz < 1e-30:
                    continue
                sx, sy, sz = norms[a]
                if nx*sx + ny*sy + nz*sz < 0:
                    a, b = b, a
                tris.append((a, b, c))
        faces += 1
    return verts, norms, tris, faces, spans


def utf16_strings(blob, minlen=4):
    """SolidWorks stores text as UTF-16LE; an ASCII scan finds almost nothing."""
    return [m.decode('utf-16-le', 'replace')
            for m in re.findall(rb'(?:[\x20-\x7e]\x00){%d,}' % minlen, blob)]


def component_refs(blobs):
    """Component file paths an assembly points at (informational — the geometry
    itself is already cached inside the assembly, so these need not be read)."""
    refs = set()
    for _, b in blobs:
        for s in utf16_strings(b):
            if re.search(r'\.(SLDPRT|SLDASM)$', s, re.I):
                refs.add(s)
    return refs


def load(path, verbose=True, combine=None, want_spans=False):
    """Decode a part or an assembly into one mesh.

    combine=None auto-selects: assemblies merge every tessellation blob (each
    holds a different chunk of the same world space), while parts take only the
    richest blob, since a part's extra blobs tend to be alternate configuration
    caches that would double-render if merged.
    """
    raw = open(path, 'rb').read()
    if combine is None:
        combine = path.lower().endswith('.sldasm')

    found = []
    for off, blob in find_blobs(raw):
        v, n, t, f, sp = decode_tess(blob)
        if not t:
            continue
        if verbose:
            print(f"   blob 0x{off:08x} ({len(blob):>10,} B) -> {f:>5} faces {len(t):>8,} tris")
        found.append((off, v, n, t, f, sp))

    if not found:
        raise SystemExit(f"no tessellation found in {path}")

    if not combine:
        _, v, n, t, f, sp = max(found, key=lambda r: len(r[3]))
        return (v, n, t, f, sp) if want_spans else (v, n, t, f)

    V, N, T, F, SP = [], [], [], 0, []
    for _, v, n, t, f, sp in found:
        base = len(V)
        V += v
        N += n
        T += [(a + base, b + base, c + base) for a, b, c in t]
        SP += [(s0 + base, c0, o0) for s0, c0, o0 in sp]
        F += f
    return (V, N, T, F, SP) if want_spans else (V, N, T, F)


if __name__ == "__main__":
    import sys
    p = sys.argv[1]
    print(p)
    v, n, t, f = load(p)
    xs = [a[0] for a in v]; ys = [a[1] for a in v]; zs = [a[2] for a in v]
    print(f"  BEST: {f} faces, {len(v)} verts, {len(t)} tris")
    print(f"  bbox mm: {(max(xs)-min(xs))*1000:.3f} x {(max(ys)-min(ys))*1000:.3f} x {(max(zs)-min(zs))*1000:.3f}")
