"""Build a bill of materials from a .SLDASM — every part, with quantities.

Walks the assembly's component table, rolls repeated instances up into
quantities, recurses into subassemblies (multiplying through), and pulls each
part's metadata (part number, description, material) from its own file.

usage:
    python bom.py <file.SLDASM> [--csv out.csv] [--tree] [--levels N]

    --tree    show the indented structure instead of a flat rolled-up list
    --csv     also write the table as CSV
    --levels  how many directories above the assembly to search for components
"""
import os, re, sys, csv, argparse
import sldprt, assembly

INST = re.compile(r'-\d+$')
# Scene furniture and view/display entries are stored as "-N" instances too, so
# they look exactly like components until you exclude them by name.
NOT_A_PART = re.compile(
    r'^(ambient|directional|spot|point|light|camera|scene|display state|'
    r'annotations|lights and cameras|sensors|equations|history|favorites|'
    r'selection sets|design binder|comments|surface bodies|solid bodies|'
    r'material|sketch|plane|origin|axis)\b', re.I)
_PROPS = {}


def is_component(name):
    """Filter out non-components before they reach the BOM."""
    if len(name) < 3 or NOT_A_PART.match(name):
        return False
    # absolute paths leak into the string pool; a component name is never a path
    return not re.search(r'[\\/]|^[A-Za-z]:', name)


def base_name(nm, idx):
    """Strip the "-N" instance suffix, but only when that actually helps.

    Vendor part numbers end in digits too ("WCP-1458", "TTB-0241"), so blind
    stripping turns them into "WCP" and "TTB". Prefer whichever form names a
    real file, and keep the full name when neither does.
    """
    nm = nm.split('@')[0].strip()
    if idx.get(nm.lower()):
        return nm
    stripped = INST.sub('', nm).strip()
    if idx.get(stripped.lower()):
        return stripped
    # "WCP-1458.step-1" -> the trailing -1 really is an instance suffix, because
    # what precedes it ends in a CAD file extension
    if re.search(r'\.(step|stp|sldprt|sldasm|igs|iges|x_t)$', stripped, re.I):
        return stripped
    return nm


def part_meta(path):
    """(part_number, description, material) read from a part/assembly file."""
    if path in _PROPS:
        return _PROPS[path]
    pn = desc = mat = ''
    try:
        raw = open(path, 'rb').read()
        for _, b in sldprt.find_blobs(raw, min_out=1024):
            i = b.find(b'<?xml')
            if i >= 0 and b'Properties' in b[i:i + 4000]:
                xml = b[i:].decode('utf-8', 'replace')
                for name, val in re.findall(
                        r'<property name="([^"]*)"[^>]*>(.*?)</property>', xml, re.S):
                    txt = re.sub(r'<[^>]+>', '', val).strip()
                    if not txt:
                        continue
                    low = name.lower()
                    if 'bom part number' in low or low in ('partno', 'part number'):
                        pn = pn or txt
                    elif low in ('description', 'sw-description'):
                        desc = desc or txt
            for s in sldprt.utf16_strings(b):
                if s.startswith('Material <') and not mat:
                    mat = s[len('Material <'):].rstrip('>')
                elif s.startswith('SW-Material') and not mat:
                    mat = s
    except Exception:
        pass
    _PROPS[path] = (pn, desc, mat)
    return _PROPS[path]


def walk(path, idx, depth=0, seen=None, levels=1):
    """Yield one row per component instance, recursing into subassemblies."""
    seen = seen or set()
    key = os.path.normcase(os.path.abspath(path))
    if key in seen:            # circular reference guard
        return
    seen = seen | {key}

    comps = assembly.read_components(path, idx, keep_unresolved=True)
    counts = {}
    for nm, _, _ in comps:
        base = base_name(nm, idx)
        if not is_component(base):
            continue
        counts[base] = counts.get(base, 0) + 1

    for base, qty in counts.items():
        f = idx.get(base.lower())
        kind = 'missing'
        if f:
            kind = 'assembly' if f.lower().endswith('.sldasm') else 'part'
        pn, desc, mat = part_meta(f) if f else ('', '', '')
        yield {'depth': depth, 'name': base, 'qty': qty, 'kind': kind,
               'part_number': pn, 'description': desc, 'material': mat,
               'file': f or ''}
        if kind == 'assembly' and depth < 4:
            for row in walk(f, idx, depth + 1, seen, levels):
                yield {**row, 'qty': row['qty'] * qty}


def build(path, levels=1):
    idx = assembly.index_files(os.path.dirname(os.path.abspath(path)), levels)
    return list(walk(path, idx, levels=levels)), idx


def rollup(rows):
    """Flat BOM: one line per distinct part, quantities summed, parts only."""
    agg = {}
    for r in rows:
        if r['kind'] == 'assembly':
            continue
        if r['name'] in agg:
            agg[r['name']]['qty'] += r['qty']
        else:
            agg[r['name']] = dict(r)
    return sorted(agg.values(), key=lambda r: (-r['qty'], r['name'].lower()))


def show(rows, tree):
    if tree:
        print(f"{'QTY':>5}  STRUCTURE")
        for r in rows:
            pad = '   ' * r['depth']
            tag = {'assembly': '[asm]', 'missing': '[!]  ', 'part': '     '}[r['kind']]
            print(f"{r['qty']:>5}  {pad}{tag} {r['name']}")
        return
    w = max([len(r['name']) for r in rows] + [12])
    print(f"{'QTY':>5}  {'PART':<{w}}  {'MATERIAL':<22}  SOURCE")
    print(f"{'-'*5}  {'-'*w}  {'-'*22}  {'-'*6}")
    for r in rows:
        src = 'MISSING' if r['kind'] == 'missing' else os.path.basename(r['file'])
        print(f"{r['qty']:>5}  {r['name']:<{w}}  {(r['material'] or '')[:22]:<22}  {src}")
    tot = sum(r['qty'] for r in rows)
    miss = sum(1 for r in rows if r['kind'] == 'missing')
    print(f"\n{len(rows)} distinct parts, {tot} total instances"
          + (f", {miss} with no file found" if miss else ""))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src")
    ap.add_argument("--csv")
    ap.add_argument("--tree", action="store_true")
    ap.add_argument("--levels", type=int, default=1)
    a = ap.parse_args()

    rows, _ = build(a.src, a.levels)
    if not rows:
        sys.exit("no components found — is this an assembly?")
    out = rows if a.tree else rollup(rows)
    show(out, a.tree)

    if a.csv:
        cols = ['qty', 'name', 'kind', 'part_number', 'description', 'material', 'file']
        with open(a.csv, 'w', newline='', encoding='utf-8-sig') as fh:
            w = csv.DictWriter(fh, fieldnames=cols, extrasaction='ignore')
            w.writeheader()
            w.writerows(out)
        print(f"-> {a.csv}")


if __name__ == "__main__":
    main()
