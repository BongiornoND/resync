"""Pull colour attributes out of Parasolid data.

Colours live in Parasolid, not in the tessellation: an `SDL/TYSA_COLOUR`
attribute carries three doubles in 0..1. That holds both for a standalone
Parasolid transmit file (.x_t / .x_b) and for the Parasolid partition that a
.SLDPRT embeds, so one extractor covers both.

usage: python colors.py <file.x_t | file.SLDPRT>
"""
import re, sys, os, struct
import sldprt

# a run of three 0..1 decimals, the way the text format writes them
TEXT_RGB = re.compile(rb'(?<![\d.])(\.\d{6,}|0|1)\s+(\.\d{6,}|0|1)\s+(\.\d{6,}|0|1)(?![\d.])')


def from_text(data):
    """Colours in an ASCII Parasolid transmit file."""
    out = {}
    for m in TEXT_RGB.finditer(data):
        try:
            rgb = tuple(round(float(x), 6) for x in m.groups())
        except ValueError:
            continue
        if not all(0.0 <= c <= 1.0 for c in rgb) or not any(c > 0 for c in rgb):
            continue
        # axis directions and unit vectors are all-0/1 triples and vastly
        # outnumber real colours; a genuine colour has a fractional component
        if all(c in (0.0, 1.0) for c in rgb):
            continue
        out[rgb] = out.get(rgb, 0) + 1
    return out


def from_binary(blob):
    """Colours in a binary Parasolid partition (big-endian doubles)."""
    out = {}
    n = len(blob)
    for p in range(0, n - 24):
        try:
            rgb = struct.unpack_from('>ddd', blob, p)
        except struct.error:
            break
        if not all(0.0 <= c <= 1.0 for c in rgb):
            continue
        if not any(c > 1e-6 for c in rgb):
            continue
        # colours SolidWorks writes are k/255, so they land on that grid
        if all(abs(c * 255 - round(c * 255)) < 1e-6 for c in rgb):
            rgb = tuple(round(c, 6) for c in rgb)
            out[rgb] = out.get(rgb, 0) + 1
    return out


def load(path):
    """{(r,g,b): count} for a Parasolid file or a SolidWorks part."""
    raw = open(path, 'rb').read()
    if raw[:2] == b'**' or path.lower().endswith(('.x_t', '.xmt_txt')):
        return from_text(raw)

    # For SolidWorks files the colours come from the appearance records in the
    # tessellation blob, counted per face -- the embedded Parasolid partition
    # names the colour attribute type but does not carry the assigned values.
    try:
        v, n, t, f, spans = sldprt.load(path, verbose=False, want_spans=True)
        out = {}
        for (_, count, _), c in zip(spans, face_colors(path, spans)):
            out[c] = out.get(c, 0) + 1
        if out:
            return out
    except (SystemExit, Exception):
        pass

    found = {}
    for _, b in sldprt.find_blobs(raw):
        if b'PS' in b[:8] or b'TRANSMIT FILE' in b[:200]:
            for k, v in from_binary(b).items():
                found[k] = found.get(k, 0) + v
    return found


APPEARANCE = re.compile(r'^[a-z0-9 ]+$')
P2M_PATH = re.compile(r'[A-Za-z]:\\\\?[^"<>|\r\n]*?\.p2m|<SystemTexture>\\[^"<>|\r\n]*?\.p2m', re.I)
SW_DATA = r"C:\Program Files\SOLIDWORKS Corp\SOLIDWORKS\data"
_P2M_CACHE = {}


def p2m_color(name, hint_paths=()):
    """Diffuse colour of a named SolidWorks appearance.

    The part stores only the appearance *name* (e.g. "greenlowglossplastic")
    plus the path of its .p2m; the actual RGB is the "col1" line inside that
    .p2m, which ships with SolidWorks.
    """
    if name in _P2M_CACHE:
        return _P2M_CACHE[name]
    key = name.replace(' ', '').lower()
    cands = []
    for h in hint_paths:
        # a hint only counts if it is the .p2m for THIS appearance; otherwise
        # every appearance resolves to whichever path happened to come first
        stem = os.path.basename(h).replace(' ', '').lower()
        if stem.endswith('.p2m') and stem[:-4] == key:
            cands.append(h.replace('<SystemTexture>', os.path.join(SW_DATA, 'graphics')))
    if os.path.isdir(SW_DATA):
        for dp, _, fs in os.walk(os.path.join(SW_DATA, 'graphics', 'materials')):
            for f in fs:
                if f.lower().endswith('.p2m') and f.lower().replace(' ', '')[:-4] == key:
                    cands.append(os.path.join(dp, f))
    for c in cands:
        try:
            txt = open(c, 'rb').read().decode('latin1')
        except OSError:
            continue
        m = re.search(r'"col1"\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)', txt)
        if m:
            rgb = tuple(float(x) for x in m.groups())
            _P2M_CACHE[name] = rgb
            return rgb
    _P2M_CACHE[name] = None
    return None


def face_colors(path, spans, default=(0.62, 0.66, 0.72)):
    """One RGB per face, in the same order as the decoder's spans.

    Appearance records are embedded *inside* the face record they apply to, so a
    marker is matched to the face whose byte range contains it. Faces with no
    marker of their own inherit the document default -- the appearance declared
    ahead of the first face.
    """
    raw = open(path, 'rb').read()
    first = spans[0][2] if spans else 0
    strings, paths = [], []
    for _, b in sldprt.find_blobs(raw):
        if not b.count(sldprt.HDR):
            continue
        for s in re.finditer(rb'(?:[\x20-\x7e]\x00){4,}', b):
            txt = s.group().decode('utf-16-le', 'replace')
            (paths if txt.lower().endswith('.p2m') else strings).append((s.start(), txt))
        break

    # An appearance name counts only if the file also references a .p2m of that
    # name. Without this the bare category word "plastic", which follows every
    # appearance record, is mistaken for one and wipes out the document default.
    valid = {os.path.basename(p).replace(' ', '').lower()[:-4] for _, p in paths}
    marks, doc = [], None
    for off, txt in strings:
        if txt.replace(' ', '').lower() not in valid:
            continue
        if off < first:
            doc = txt
        else:
            marks.append((off, txt))

    bounds = [o for _, _, o in spans] + [1 << 60]
    out = []
    for i in range(len(spans)):
        name = doc
        for off, nm in marks:
            if bounds[i] <= off < bounds[i + 1]:
                name = nm
                break
        rgb = p2m_color(name, [q for _, q in paths]) if name else None
        out.append(rgb or default)
    return out


def dominant(path, default=(0.62, 0.66, 0.72)):
    """Most frequently applied colour, for use as the render's base colour."""
    c = load(path)
    if not c:
        return default
    return max(c.items(), key=lambda kv: kv[1])[0]


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for p in sys.argv[1:]:
        c = load(p)
        print(f"\n{os.path.basename(p)}: {len(c)} distinct colours")
        for rgb, n in sorted(c.items(), key=lambda kv: -kv[1])[:10]:
            r, g, b = (round(x * 255) for x in rgb)
            print(f"   rgb({r:>3},{g:>3},{b:>3})  #{r:02x}{g:02x}{b:02x}  x{n}")
