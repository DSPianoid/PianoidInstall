"""dev-f116 — render report pages to PNG for visual inspection.

Reuses ReportGenerator's per-page renderers but saves each figure as a
PNG instead of a PDF page, so the agent can Read the images to verify
the report contents (cover table, per-mode fields, grid heatmap with the
smoothing blend, line amplitude strip, shape chart).

Usage:
    .venv/Scripts/python dev-f116-render-png.py <project> <out_dir> <chain_id> <smoothing>
"""
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

from pianoid_middleware.modal_adapter.modal_adapter import ModalAdapter


def main():
    project = sys.argv[1]
    out_dir = sys.argv[2]
    chain_id = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    smoothing = float(sys.argv[4]) if len(sys.argv) > 4 else 1.5
    os.makedirs(out_dir, exist_ok=True)

    adapter = ModalAdapter()
    adapter.open_project(project)
    rg = adapter._report_generator
    ctx = adapter._ctx
    layout = "grid" if (ctx.mapping and ctx.mapping.is_grid) else "line"

    # find the chain dict with this chain_id
    chain = next((c for c in ctx.tracked_chains
                  if c.get("chain_id") == chain_id), None)
    if chain is None:
        print(f"chain {chain_id} not found")
        sys.exit(1)
    response_channels = ctx.mapping.response_channels if ctx.mapping else []

    chains_sorted = sorted(ctx.tracked_chains,
                           key=lambda c: c.get("frequency_mean", 0.0))[:8]

    cover_png = os.path.join(out_dir, f"{project}_cover.png")
    _render_cover_png(rg, chains_sorted, layout, project, smoothing, cover_png)
    print("wrote", cover_png)

    # Render one mode page
    page_png = os.path.join(out_dir, f"{project}_mode_{chain_id}.png")
    _render_mode_png(rg, chain, layout, response_channels, smoothing, page_png)
    print("wrote", page_png)


def _render_cover_png(rg, chains, layout, project, smoothing, path):
    fig = plt.figure(figsize=(8.27, 11.69))
    fig.suptitle(f"Modal Tracking Report — {project}", fontsize=16,
                 fontweight="bold", y=0.97)
    from datetime import datetime
    header = (f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}\n"
              f"Export set: {len(chains)} modes   ·   Layout: {layout}   ·   "
              f"Heatmap smoothing: {smoothing}")
    fig.text(0.5, 0.925, header, ha="center", va="top", fontsize=9)
    col_labels = ["Mode", "Freq range (Hz)", "Damping (zeta)", "MAC",
                  "Stability (#sc)"]
    rows = []
    for i, c in enumerate(chains):
        fr = c.get("frequency_range") or [0.0, 0.0]
        rows.append([str(c.get("chain_id", i)), f"{fr[0]:.1f} – {fr[1]:.1f}",
                     f"{c.get('damping_mean', 0.0):.5f}", rg._mac_str(c),
                     str(c.get("detection_count", 0))])
    ax = fig.add_axes([0.06, 0.05, 0.88, 0.83])
    ax.axis("off")
    table = ax.table(cellText=rows, colLabels=col_labels, cellLoc="center",
                     loc="upper center")
    table.auto_set_font_size(False)
    table.set_fontsize(8)
    table.scale(1.0, 1.3)
    fig.savefig(path, dpi=110)
    plt.close(fig)


def _render_mode_png(rg, chain, layout, response_channels, smoothing, path):
    from matplotlib.gridspec import GridSpec
    fig = plt.figure(figsize=(8.27, 11.69))
    fig.suptitle(f"Mode — Chain {chain.get('chain_id')}", fontsize=14,
                 fontweight="bold", y=0.97)
    gs = GridSpec(3, 1, figure=fig, height_ratios=[0.7, 1.0, 1.0],
                  top=0.92, bottom=0.06, left=0.10, right=0.92, hspace=0.35)
    rg._render_metadata_block(fig, gs[0], chain)
    ax_heat = fig.add_subplot(gs[1])
    if layout == "grid":
        rg._render_grid_heatmap(fig, ax_heat, chain.get("chain_id"), smoothing)
    else:
        rg._render_amplitude_strip(ax_heat, chain)
    ax_shape = fig.add_subplot(gs[2])
    rg._render_shape_chart(ax_shape, chain, response_channels)
    fig.savefig(path, dpi=110)
    plt.close(fig)


if __name__ == "__main__":
    main()
