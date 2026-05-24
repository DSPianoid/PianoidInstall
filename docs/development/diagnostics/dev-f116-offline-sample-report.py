"""dev-f116 offline sample-report generator.

Loads a real on-disk modal-adapter project via the ModalAdapter facade
(NO live server, NO synthesis engine touched) and generates a
tracking-results PDF for a sample export set. Used to produce sample
PDFs for the user to eyeball.

Usage:
    .venv/Scripts/python docs/development/diagnostics/dev-f116-offline-sample-report.py \
        <project_name> <output_dir> [n_chains]

Loading a project from disk: ModalAdapter.open_project(name) hydrates
ctx.tracked_chains / ctx.mapping / ctx.project_dir from the persisted
modal_adapter/{tracking,mapping}/ files — exactly the path the REST
``/modal/projects/<n>/open`` endpoint uses. We then call
generate_tracking_report with an explicit output_dir so we don't write
into the real project directory during testing.
"""
import sys

from pianoid_middleware.modal_adapter.modal_adapter import ModalAdapter


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    project = sys.argv[1]
    output_dir = sys.argv[2]
    n_chains = int(sys.argv[3]) if len(sys.argv) > 3 else 12

    adapter = ModalAdapter()
    print(f"Opening project {project!r} ...")
    adapter.open_project(project)

    chains = adapter._ctx.tracked_chains
    mapping = adapter._ctx.mapping
    layout = "grid" if (mapping and mapping.is_grid) else "line"
    print(f"  tracked chains: {len(chains)}")
    print(f"  layout: {layout}")
    if not chains:
        print("  NO CHAINS — cannot generate. Has tracking been run?")
        sys.exit(1)

    # Sample export set: the first n_chains chains sorted by frequency
    # (a realistic curated subset). chain_ids are the dict 'chain_id's.
    by_freq = sorted(chains, key=lambda c: c.get("frequency_mean", 0.0))
    export_set = [c["chain_id"] for c in by_freq[:n_chains]]
    print(f"  sample export set: {export_set}")

    result = adapter.generate_tracking_report(
        output_dir=output_dir,
        selected_chain_ids=export_set,
        smoothing=1.5,
    )
    print("RESULT:")
    for k, v in result.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
