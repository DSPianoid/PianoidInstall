"""dev-dad7 — P0 mode-scaling measurement #3: deck coupling-shape analysis (offline, read-only on preset JSON).

Data-model facts used (doc-supported, see the P0 report's Data Model Card):
  * preset pitch['deck'] = base64 float64 array shape [2, num_modes] = stack([feedin, feedback])
    (DATA_FLOWS.md "Preset file format" + Pitch.pack_for_saving_preset).
  * Kernel deck (single-matrix mode, USE_SINGLE_DECK_MATRIX=1) = one row PER STRING (pitch_index has one
    entry per string, every string of a pitch carries its pitch's row); piano rows = effective_deck('feedin')
    used for BOTH directions (string->mode feedin and mode->string feedback, reciprocity);
    output pitches (>=128) rows = effective_deck('feedback') x string-SC gain (context doc §1.1/§2.4).
  * No deck_mask in these presets -> effective == raw.
  * Mode frequency: preset 'frequency' if stored, else legacy sqrt(stiffness/mass)/(2*pi) with the stored
    'mass' field read as mass_inv (Mode.py fit_params legacy path; OVERVIEW "Piano_mode").
Analysis per preset:
  A. per-mode column profile over piano strings: CV, |cos| to the all-ones vector, sign mix -> flatness vs f.
  B. SVD energy spectrum of the piano-string x mode coupling matrix (all modes, and HF tails).
  C. shape clustering of mode columns by |normalised correlation| (sign-free: the per-mode gain a(m)
     absorbs sign + scale): complete-linkage agglomerative => G at tau in {0.9, 0.95, 0.99}; plus the
     rank-1-per-group residual energy, for the flat band at several candidate n_shaped boundaries.
  D. reciprocity: stored feedin vs feedback per piano pitch (a_in == a_out ?).
Usage: python dev-dad7-deck-shape-analysis.py <preset.json> [...]
"""
import base64, json, math, sys
import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage
from scipy.spatial.distance import squareform


def decode(d):
    return np.frombuffer(base64.b64decode(d["data"]), np.dtype(d["type"])).reshape(d["shape"])


def mode_freqs(modes):
    f = []
    for m in modes:
        if "frequency" in m and m["frequency"]:
            f.append(float(m["frequency"]))
        else:
            f.append(math.sqrt(m["stiffness"] / m["mass"]) / (2 * math.pi))
    return np.array(f)


def load(path):
    d = json.load(open(path))
    nm = d["model_parameters"]["num_modes"]
    rows, row_pitch, fb_rows, out_rows = [], [], [], []
    for pid in sorted(d["pitches"], key=int):
        p = d["pitches"][pid]
        deck = decode(p["deck"])[:, :nm]
        if int(pid) >= 128:
            out_rows.append(deck[1])
            continue
        fb_rows.append((int(pid), deck[0], deck[1]))
        for _ in p["strings"]:
            rows.append(deck[0]); row_pitch.append(int(pid))
    return d, np.array(rows), np.array(row_pitch), fb_rows, np.array(out_rows), mode_freqs(d["modes"][:nm])


def svd_k(M, fracs=(0.9, 0.99, 0.999)):
    s = np.linalg.svd(M, compute_uv=False)
    e = np.cumsum(s ** 2) / np.sum(s ** 2)
    return [int(np.searchsorted(e, fr) + 1) for fr in fracs], s


def cluster(cols, tau):
    """cols: [n_modes x n_strings]. Complete linkage on 1-|corr| => every pair in a group has |corr|>=tau."""
    n = cols.shape[0]
    if n == 1:
        return np.array([1])
    U = cols / np.linalg.norm(cols, axis=1, keepdims=True)
    C = np.clip(np.abs(U @ U.T), 0, 1)
    D = 1 - C; np.fill_diagonal(D, 0)
    Z = linkage(squareform(D, checks=False), method="complete")
    return fcluster(Z, t=1 - tau, criterion="distance")


def rank1_residual(cols, labels):
    """Energy fraction NOT captured when each group is replaced by its best rank-1 a(m)*w_g(s)."""
    tot, res = np.sum(cols ** 2), 0.0
    for g in np.unique(labels):
        s = np.linalg.svd(cols[labels == g], compute_uv=False)
        res += np.sum(s[1:] ** 2)
    return res / tot


def per_mode_resid_groups(cols, labels):
    """Per-mode relative amplitude error ||c_m - a_m w_g|| / ||c_m|| with w_g = group's top singular vector."""
    r = np.zeros(cols.shape[0])
    for g in np.unique(labels):
        idx = np.where(labels == g)[0]
        _, _, vt = np.linalg.svd(cols[idx], full_matrices=False)
        w = vt[0]
        for i in idx:
            c = cols[i]; r[i] = np.linalg.norm(c - (c @ w) * w) / np.linalg.norm(c)
    return r


def lowrank_r_needed(cols, tols=(0.10, 0.05, 0.01)):
    """Shared-basis (rank-r) form: c_m ~ sum_k A[m,k] b_k. Basis from SVD of per-mode-NORMALISED columns
    (every mode weighted equally - a(m) absorbs scale). Returns smallest r with max per-mode rel. error <= tol."""
    U = cols / np.linalg.norm(cols, axis=1, keepdims=True)
    _, _, vt = np.linalg.svd(U, full_matrices=False)
    out = []
    for tol in tols:
        for r in range(1, vt.shape[0] + 1):
            B = vt[:r]
            err = np.linalg.norm(U - (U @ B.T) @ B, axis=1)
            if err.max() <= tol:
                out.append(r); break
    return out


def analyse(path):
    d, Dm, row_pitch, fb_rows, out_rows, f = load(path)
    S, M = Dm.shape
    name = path.replace("\\", "/").split("/")[-1]
    print(f"\n## {name}\npiano strings S={S} (pitches={len(fb_rows)}), modes M={M}, f range {f.min():.1f}-{f.max():.1f} Hz, "
          f"output rows={len(out_rows)}; freq-sorted={bool(np.all(np.diff(f) >= 0))}")
    order = np.argsort(f); f = f[order]; Dm = Dm[:, order]
    if len(out_rows):
        out_rows = out_rows[:, order]
    cols = Dm.T  # [M x S]
    norms = np.linalg.norm(cols, axis=1)
    zero = norms < 1e-15
    print(f"zero-coupling modes: {int(zero.sum())}")

    # A. flatness vs frequency
    mean = cols.mean(1); std = cols.std(1)
    cv = std / np.maximum(np.abs(mean), 1e-30)
    ones = np.ones(S) / math.sqrt(S)
    cos1 = np.abs(cols @ ones) / np.maximum(norms, 1e-30)
    negfrac = np.array([min((c < 0).mean(), (c > 0).mean()) for c in cols])
    # neighbour similarity (adjacent modes in f) -> where shapes stop changing
    U = cols / np.maximum(norms, 1e-30)[:, None]
    nb = np.r_[np.nan, np.abs(np.sum(U[1:] * U[:-1], axis=1))]
    print("\n### A. column flatness by frequency band (piano strings)")
    print("| band (Hz) | modes | median CV=std/|mean| | median |cos(col, 1)| | median minority-sign frac | median |corr| to f-neighbour |")
    print("|---|---|---|---|---|---|")
    edges = [0, 100, 200, 400, 800, 1600, 3200, 1e9]
    for lo, hi in zip(edges[:-1], edges[1:]):
        k = (f >= lo) & (f < hi) & ~zero
        if k.sum() == 0:
            continue
        print(f"| {lo:.0f}-{'inf' if hi > 1e8 else int(hi)} | {int(k.sum())} | {np.median(cv[k]):.2f} | {np.median(cos1[k]):.3f} | "
              f"{np.median(negfrac[k]):.2f} | {np.nanmedian(nb[k]):.3f} |")

    # B. SVD
    print("\n### B. SVD energy (piano-string x mode matrix; rank-1 terms for 90 / 99 / 99.9 % energy)")
    print("| subset | modes | k90 | k99 | k99.9 | sigma2/sigma1 |")
    print("|---|---|---|---|---|---|")
    for lab, k in [("all modes", np.ones(M, bool)), ("f >= 400 Hz", f >= 400), ("f >= 800 Hz", f >= 800),
                   ("f >= 1600 Hz", f >= 1600), ("f >= 3200 Hz", f >= 3200)]:
        k &= ~zero
        if k.sum() < 2:
            continue
        ks, s = svd_k(Dm[:, k])
        print(f"| {lab} | {int(k.sum())} | {ks[0]} | {ks[1]} | {ks[2]} | {s[1]/s[0]:.3f} |")
    # per-pitch (dedup strings) as a cross-check — duplication of unison rows weights but adds no rank
    _, up = np.unique(row_pitch, return_index=True)
    ks, _ = svd_k(Dm[up][:, ~zero])
    print(f"| all modes, one row per PITCH (dedup unisons) | {int((~zero).sum())} | {ks[0]} | {ks[1]} | {ks[2]} | - |")

    # C. clustering => G
    print("\n### C. shape groups G (complete linkage on |corr|; every pair in a group >= tau) + rank-1/group residual energy")
    print("| flat band = modes with f >= | n_shaped (below) | n_flat | G@0.90 | resid@0.90 | G@0.95 | resid@0.95 | G@0.99 | resid@0.99 |")
    print("|---|---|---|---|---|---|---|---|---|")
    for fcut in [0, 400, 800, 1600, 3200]:
        k = (f >= fcut) & ~zero
        if k.sum() < 2:
            continue
        line = f"| {fcut} Hz | {int((f < fcut).sum())} | {int(k.sum())} |"
        for tau in (0.9, 0.95, 0.99):
            lab = cluster(cols[k], tau)
            line += f" {lab.max()} | {100*rank1_residual(cols[k], lab):.2f}% |"
        print(line)

    # C2. per-mode accuracy: groups vs shared low-rank basis
    print("\n### C2. per-mode relative amplitude error ||c_m - approx|| / ||c_m||  (G=1 = one global shape)")
    print("| flat band f >= | n_flat | G=1 median / max | G@0.95 median / max | G@0.99 median / max | shared-basis r for max err <= 10% / 5% / 1% |")
    print("|---|---|---|---|---|---|")
    for fcut in [0, 400, 800, 1600, 3200]:
        k = (f >= fcut) & ~zero
        if k.sum() < 2:
            continue
        c = cols[k]
        r1 = per_mode_resid_groups(c, np.ones(len(c), int))
        r95 = per_mode_resid_groups(c, cluster(c, 0.95)); r99 = per_mode_resid_groups(c, cluster(c, 0.99))
        rs = lowrank_r_needed(c)
        print(f"| {fcut} Hz | {int(k.sum())} | {np.median(r1):.3f} / {r1.max():.3f} | {np.median(r95):.3f} / {r95.max():.3f} | "
              f"{np.median(r99):.3f} / {r99.max():.3f} | {' / '.join(map(str, rs))} |")

    # D. reciprocity
    rel = []
    for pid, fi, fb in fb_rows:
        n = np.linalg.norm(fi)
        if n > 0:
            rel.append(np.linalg.norm(fi - fb) / n)
    rel = np.array(rel)
    print(f"\n### D. reciprocity (stored feedin vs feedback, piano pitches): max ||fi-fb||/||fi|| = {rel.max():.3e}, "
          f"median = {np.median(rel):.3e}, pitches identical = {(rel == 0).sum()}/{len(rel)}")
    if len(out_rows):
        ks, s = svd_k(out_rows[:, ~zero])
        print(f"output rows (feedback readout, {len(out_rows)} ch): k90/k99 = {ks[0]}/{ks[1]}")
    return f, cv, cos1, nb


if __name__ == "__main__":
    np.set_printoptions(precision=3, suppress=True)
    for p in sys.argv[1:]:
        analyse(p)
