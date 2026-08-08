"""Resolve a .SLDASM into world-space geometry by placing its component files.

An assembly's own graphics cache holds every component's mesh, but each cache
block sits in its own local frame and the block->component mapping is not
recoverable, so merging the cache directly piles parts on top of each other.
Instead this walks the component table: each instance names a part/assembly file
and carries a 4x4 placement, so we load each component's own tessellation (which
is correct in its local frame) and transform it into world space.

usage: python assembly.py <file.SLDASM> [--transpose]
"""
import os, re, math, struct, sys
import sldprt, colors as colormod

VIEW_NAMES = re.compile(r'^\*')          # *Front, *Isometric, ... are named views, not parts
INST_SUFFIX = re.compile(r'-\d+$')


def _orthonormal(m):
    try:
        return all(abs(math.sqrt(sum(x * x for x in m[r*3:r*3+3])) - 1) < 1e-9 for r in range(3))
    except ValueError:
        return False


def _utf16(blob):
    return [(m.start(), m.group().decode('utf-16-le', 'replace'))
            for m in re.finditer(rb'(?:[\x20-\x7e]\x00){4,}', blob)]


def read_components(path, idx=None, ground=True, keep_unresolved=False):
    """[(instance_name, R(9), t(3)), ...] for one assembly file.

    Several blobs carry orthonormal matrices next to names — the mate blob holds
    far more of them than the component table does, so "most matches" picks the
    wrong one. Score instead by how many names resolve to real component files.
    """
    IDENT = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
    ORIGIN = (0.0, 0.0, 0.0)
    raw = open(path, 'rb').read()
    best, best_score = [], -1

    for _, B in sldprt.find_blobs(raw):
        S = _utf16(B)
        if not S:
            continue

        # instance anchors: unqualified names ending in -N that name a real file.
        # Mate records qualify names with "@Assembly", which excludes that blob.
        anchors, seen, resolvable = [], set(), 0
        for p, s in S:
            s = s.strip()
            if '@' in s or VIEW_NAMES.match(s):
                continue
            m = re.match(r'^(.*-\d+)', s)
            if not m:
                continue
            nm = m.group(1)
            if nm in seen:
                continue
            known = idx is None or bool(idx.get(INST_SUFFIX.sub('', nm).strip().lower()))
            # a BOM wants every instance listed, including ones whose file is
            # missing; the renderer only wants the ones it can actually load
            if not known and not keep_unresolved:
                continue
            resolvable += known
            seen.add(nm)
            anchors.append((p, nm))
        if not anchors:
            continue

        mats, q = [], 0
        while q < len(B) - 104:
            m = struct.unpack_from('<9d', B, q)
            if all(abs(x) <= 1.0001 for x in m) and _orthonormal(m):
                t = struct.unpack_from('<3d', B, q + 72)
                sc = struct.unpack_from('<d', B, q + 96)[0]
                if all(abs(x) < 5.0 for x in t) and abs(sc - 1.0) < 1e-6:
                    mats.append((q, m, t))
                    q += 104
                    continue
            q += 1

        # Pair each instance with the first transform inside ITS OWN record span.
        # Span-bounded beats "nearest preceding string": it can tell a genuinely
        # transform-less (grounded) component from one that just sits far from
        # its matrix, which is what makes the identity fallback below safe.
        bounds = [p for p, _ in anchors] + [len(B)]
        entries, withT = [], 0
        for i, (p, nm) in enumerate(anchors):
            span = [x for x in mats if p <= x[0] < bounds[i + 1]]
            if span:
                entries.append((nm, span[0][1], span[0][2]))
                withT += 1
            elif ground:
                # SolidWorks fixes/grounds components (the first one especially)
                # with no matrix stored at all; those belong at the origin.
                entries.append((nm, IDENT, ORIGIN))
        # score on transforms found among *resolvable* names, so keeping
        # unresolved instances for a BOM cannot change which blob is chosen
        score = min(withT, resolvable) if keep_unresolved else withT
        if score > best_score:
            best, best_score = entries, score

    return best


def index_files(root, levels=1, cap=60000):
    """Index component files, searching `levels` directories above `root` too.

    Assemblies routinely sit in a subfolder while shared/vendor parts live beside
    it in the project tree, so indexing only the assembly's own folder loses most
    of them. Widening one level up is the difference between resolving 26 and 56
    instances on the test assembly. Falls back to the narrow root if a parent
    turns out to be enormous.
    """
    start = os.path.abspath(root)
    top = start
    for _ in range(max(0, levels)):
        parent = os.path.dirname(top)
        if parent == top:
            break
        top = parent

    def walk(base):
        idx = {}
        for dp, _, fs in os.walk(base):
            for f in fs:
                if f.lower().endswith(('.sldprt', '.sldasm')) and not f.startswith('~$'):
                    idx.setdefault(os.path.splitext(f)[0].lower(), os.path.join(dp, f))
                    if len(idx) > cap:
                        return None
        return idx

    return walk(top) or walk(start) or {}


def _envelope(V, margin=0.02):
    """Axis-aligned extent of already-placed geometry, in metres, plus slack."""
    if not V:
        return None
    xs = [p[0] for p in V]; ys = [p[1] for p in V]; zs = [p[2] for p in V]
    return (min(xs) - margin, max(xs) + margin,
            min(ys) - margin, max(ys) + margin,
            min(zs) - margin, max(zs) + margin)


def _fraction_inside(pts, env, step=13):
    s = pts[::step] or pts
    if not s:
        return 0.0
    n = sum(1 for p in s if env[0] <= p[0] <= env[1]
            and env[2] <= p[1] <= env[3] and env[4] <= p[2] <= env[5])
    return n / len(s)


def _apply(v, R, t, transpose):
    x, y, z = v
    if transpose:
        return (R[0]*x + R[1]*y + R[2]*z + t[0],
                R[3]*x + R[4]*y + R[5]*z + t[1],
                R[6]*x + R[7]*y + R[8]*z + t[2])
    return (R[0]*x + R[3]*y + R[6]*z + t[0],
            R[1]*x + R[4]*y + R[7]*z + t[1],
            R[2]*x + R[5]*y + R[8]*z + t[2])


def _with_colors(f):
    """(verts, norms, tris, faces, per-vertex rgb) for one component file."""
    v, n, t, fc, spans = sldprt.load(f, verbose=False, want_spans=True)
    cols = [(0.62, 0.66, 0.72)] * len(v)
    try:
        for (start, count, _), c in zip(spans, colormod.face_colors(f, spans)):
            for k in range(start, min(start + count, len(v))):
                cols[k] = c
    except Exception:
        pass
    return v, n, t, fc, cols


def build(path, root=None, transpose=False, verbose=True, levels=1,
          ground=True, want_colors=False, _depth=0, _cache=None):
    """Returns (verts, norms, tris, faces[, per-vertex rgb]) in world coords."""
    root = root or os.path.dirname(os.path.abspath(path))
    if _cache is None:
        _cache = {'idx': index_files(root, levels), 'part': {}}
    idx = _cache['idx']

    comps = read_components(path, idx, ground)
    if verbose:
        print(f"{'  '*_depth}{os.path.basename(path)}: {len(comps)} component instances")

    # Components carrying a real transform are trustworthy. Grounded ones (no
    # matrix stored at all) are only a guess at identity, so place the firm set
    # first and use its extent to sanity-check each guess.
    IDENT = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
    firm = [c for c in comps if c[1] != IDENT or any(c[2])]
    guess = [c for c in comps if c[1] == IDENT and not any(c[2])]

    V, N, T, F, C = [], [], [], 0, []
    placed = missing = 0

    def component(nm):
        f = idx.get(INST_SUFFIX.sub('', nm.split('@')[0]).strip().lower())
        if not f:
            return None
        key = os.path.normcase(f)
        if key not in _cache['part']:
            try:
                if f.lower().endswith('.sldasm'):
                    sub = ([], [], [], 0, [])
                    if _depth < 3:
                        sub = build(f, root, transpose, verbose, levels, ground,
                                    True, _depth + 1, _cache)
                    if not sub[2]:
                        # Vendor subassemblies (STEP imports) expose no component
                        # table and their parts no longer exist as separate files.
                        # They carry a single tessellation blob already in one
                        # coordinate system, so that cache is usable as-is.
                        sub = _with_colors(f)
                    _cache['part'][key] = sub
                else:
                    _cache['part'][key] = _with_colors(f)
            except (SystemExit, Exception):
                _cache['part'][key] = ([], [], [], 0, [])
        r = _cache['part'][key]
        return r if r[2] else None

    def place(part, R, t):
        nonlocal F, placed
        pv, pn, pt, pf, pc = part
        b = len(V)
        V.extend(_apply(v, R, t, transpose) for v in pv)
        N.extend(_apply(n, R, (0.0, 0.0, 0.0), transpose) for n in pn)
        T.extend((a + b, c + b, d + b) for a, c, d in pt)
        # colours are per-vertex and orientation-independent, so they carry over
        # unchanged; pad if a component somehow yielded fewer than it has verts
        C.extend(pc if len(pc) == len(pv) else [(0.62, 0.66, 0.72)] * len(pv))
        F += pf
        placed += 1

    for nm, R, t in firm:
        part = component(nm)
        if part is None:
            missing += 1
            continue
        place(part, R, t)

    env = _envelope(V)
    for nm, R, t in guess:
        part = component(nm)
        if part is None:
            missing += 1
            continue
        # A wrong identity guess parks the component off beside the assembly
        # instead of inside it, which is both visually obvious and easy to test.
        if env and _fraction_inside(part[0], env) < 0.5:
            if verbose:
                print(f"{'  '*_depth}  skipped {nm}: identity puts it outside the assembly")
            missing += 1
            continue
        place(part, R, t)

    if verbose:
        print(f"{'  '*_depth}  placed {placed}, unresolved {missing}, "
              f"{len(V):,} verts, {len(T):,} tris")
    return (V, N, T, F, C) if want_colors else (V, N, T, F)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    v, n, t, f = build(sys.argv[1], transpose='--transpose' in sys.argv,
                       ground='--no-ground' not in sys.argv)
    xs = [a[0] for a in v]; ys = [a[1] for a in v]; zs = [a[2] for a in v]
    print(f"bbox mm: {(max(xs)-min(xs))*1000:.1f} x {(max(ys)-min(ys))*1000:.1f} "
          f"x {(max(zs)-min(zs))*1000:.1f}")
