"""
dev-steinway-preset: derive per-pitch string physics from the Steinway 1860 mensur sheet.

Source of truth: the xlsx (parsed as zip-of-XML). Columns:
  A = номер хора (choir number);  MIDI = choir + 20
  D = core diameter mm (present only for WOUND strings)
  F = overall diameter mm (always present; for PLAIN strings this IS the bare wire)
  J = speaking length mm
Classification (from GEOMETRY, NOT the inverted CSV label):
  WOUND  if col D present (and F > D)  -> choir 1..21  (MIDI 21..41, A0..F2)
  PLAIN  if col D empty                -> choir 22..85 (MIDI 42..105, F#2..A7)

User-approved derivation (constants + formulas) — see team-lead spec:
  rho_steel = 7850, rho_Cu = 8960 kg/m^3
  r (radius, metres):  WOUND = core(D)/2 ;  PLAIN = wire(F)/2
  rho (linear kg/m):
     PLAIN  = rho_steel * pi * r^2
     WOUND  = rho_steel*pi*(D/2)^2 + 0.88*rho_Cu*pi*((F/2)^2 - (D/2)^2)
  tension (N): T = 4 * L^2 * f^2 * rho ;  f = 440*2^((MIDI-69)/12) ; L = engine speaking length (m)
  length: real Steinway col J (m), clamp UP only per the <4-main-points rule (applied later in the layout step)
  Extrapolation MIDI 106/107/108 (plain): L *= 0.9398 per semitone from 105; wire 0.775mm (r=0.0003875); rho=steel.
"""
import zipfile, re, math
import xml.etree.ElementTree as ET

XLSX = r"D:\repos\PianoidInstall\PianoidCore\pianoid_middleware\presets\Стейнвей 1860 Мензура (1).xlsx"
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'

RHO_STEEL = 7850.0
RHO_CU = 8960.0
CU_PACK = 0.88

def f_et(midi):
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)

def parse_xlsx():
    z = zipfile.ZipFile(XLSX)
    shared = []
    try:
        sst = ET.fromstring(z.read('xl/sharedStrings.xml'))
        for si in sst:
            shared.append(''.join((t.text or '') for t in si.iter(NS + 't')))
    except KeyError:
        pass
    root = ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
    rows = {}
    for c in root.iter(NS + 'c'):
        ref = c.get('r'); t = c.get('t'); v = c.find(NS + 'v')
        val = None
        if v is not None:
            val = shared[int(v.text)] if t == 's' else v.text
        col = re.match(r'([A-Z]+)', ref).group(1)
        rn = int(re.match(r'[A-Z]+(\d+)', ref).group(1))
        rows.setdefault(rn, {})[col] = val
    return rows

def num(x):
    if x is None or x == '' or (isinstance(x, str) and x.strip() == ''):
        return None
    try:
        return float(x)
    except ValueError:
        return None

def choir_int(a):
    # 'номер хора' may be '11а' etc. Take the leading integer; skip the 'а' sub-rows.
    if a is None: return None, False
    m = re.match(r'^(\d+)\s*([а-яА-Яa]*)$', a.strip())
    if not m: return None, False
    return int(m.group(1)), bool(m.group(2))  # (choir_no, is_sub_row)

def build_per_note():
    rows = parse_xlsx()
    per_choir = {}  # choir_no -> dict (primary row only)
    for rn in sorted(rows):
        cells = rows[rn]
        cno, is_sub = choir_int(cells.get('A'))
        if cno is None:
            continue
        if cno in per_choir:    # already have primary; skip 'а' duplicates
            continue
        D = num(cells.get('D'))  # core mm
        F = num(cells.get('F'))  # overall mm
        J = num(cells.get('J'))  # length mm
        if F is None or J is None:
            continue
        wound = D is not None
        midi = cno + 20
        per_choir[cno] = dict(choir=cno, midi=midi, core_mm=D, overall_mm=F, length_mm=J, wound=wound, src_row=rn)
    return per_choir

def derive_one(midi, length_m, core_mm, overall_mm, wound):
    f = f_et(midi)
    if wound:
        D = core_mm / 1000.0      # core dia m
        Fo = overall_mm / 1000.0  # overall dia m
        r = D / 2.0               # "use core r"
        rho = RHO_STEEL * math.pi * (D/2)**2 + CU_PACK * RHO_CU * math.pi * ((Fo/2)**2 - (D/2)**2)
    else:
        wire = overall_mm / 1000.0
        r = wire / 2.0
        rho = RHO_STEEL * math.pi * r**2
    T = 4.0 * length_m**2 * f**2 * rho
    return dict(f=f, r=r, rho=rho, tension=T)

def full_keyboard():
    """Return dict midi -> derived physics for MIDI 21..108 (full 88-key A0..C8)."""
    per_choir = build_per_note()
    by_midi = {v['midi']: v for v in per_choir.values()}
    out = {}
    # sheet-covered: MIDI 21..105
    for midi in range(21, 106):
        rec = by_midi.get(midi)
        if rec is None:
            continue
        d = derive_one(midi, rec['length_mm']/1000.0, rec['core_mm'], rec['overall_mm'], rec['wound'])
        out[midi] = dict(midi=midi, length_m=rec['length_mm']/1000.0, wound=rec['wound'],
                         core_mm=rec['core_mm'], overall_mm=rec['overall_mm'], **d)
    # extrapolate 106,107,108 (plain treble), from MIDI 105 length
    L105 = by_midi[105]['length_mm']/1000.0
    wire_top = 0.775/1000.0
    r_top = wire_top/2
    rho_top = RHO_STEEL*math.pi*r_top**2
    Lprev = L105
    for midi in (106,107,108):
        Lprev = Lprev * 0.9398
        f = f_et(midi)
        T = 4.0*Lprev**2*f**2*rho_top
        out[midi] = dict(midi=midi, length_m=Lprev, wound=False, core_mm=None, overall_mm=0.775,
                         f=f, r=r_top, rho=rho_top, tension=T, extrapolated=True)
    return out

if __name__ == "__main__":
    out = full_keyboard()
    print(f"{'MIDI':>4} {'note':>5} {'type':>6} {'L(m)':>8} {'f(Hz)':>9} {'r(m)':>10} {'rho(kg/m)':>11} {'T(N)':>10} {'core':>6} {'over':>6}")
    NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
    for midi in sorted(out):
        d = out[midi]
        name = f"{NAMES[midi%12]}{midi//12 - 1}"
        typ = 'WOUND' if d['wound'] else 'plain'
        ext = '*' if d.get('extrapolated') else ' '
        core_s = '' if d['core_mm'] is None else f"{d['core_mm']:.3f}"
        print(f"{midi:>4} {name:>5} {typ:>6}{ext} {d['length_m']:>8.4f} {d['f']:>9.3f} {d['r']:>10.6f} {d['rho']:>11.6f} {d['tension']:>10.2f} "
              f"{core_s:>6} {d['overall_mm']:>6.3f}")
    # sanity: A0 rho should be ~0.195
    print()
    print(f"A0 (MIDI 21) rho = {out[21]['rho']:.5f} kg/m  (sanity target ~0.195)")
    print(f"A0 (MIDI 21) tension = {out[21]['tension']:.2f} N")
    print(f"A4 (MIDI 69) f = {out[69]['f']:.3f} Hz (should be 440.000)")
