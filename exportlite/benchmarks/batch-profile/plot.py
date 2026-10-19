import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

directory = Path(__file__).resolve().parent.parent / "results" / "batch-profile"
rows = json.loads((directory / "summary.json").read_text())
matched = {row["method"]: row for row in rows if row["dataset"] == "matched" and row["mode"] == "output"}
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11})
figure, ax = plt.subplots(figsize=(10, 3.6))
figure.patch.set_facecolor("white")
methods = ["full", "before", "after"]
labels = ["Full SQLite aggregation", "ExportLite before", "ExportLite after"]
for index, method in enumerate(methods):
    row = matched[method]
    generation = row["generationMs"]
    ax.barh(index, generation, height=0.5, color="#237a97", label="JSON generation / pipeline" if index == 0 else None)
    ax.barh(index, row["encodingMs"], left=generation, height=0.5, color="#e6a535", label="UTF-8 encoding" if index == 0 else None)
    ax.text(row["totalMs"] + 4, index, f'{row["totalMs"]:.1f} ms', va="center", weight="bold", color="#243347")
ax.set_yticks(range(3), labels)
ax.invert_yaxis()
ax.set_xlim(0, 260)
ax.set_xlabel("Total response-body production time, ms")
ax.set_title("A simpler batch-boundary query removes most of the avoidable gap", loc="left", pad=28, weight="bold")
ax.spines[["top", "right", "left"]].set_visible(False)
ax.tick_params(axis="y", length=0, pad=12)
ax.xaxis.grid(True, color="#e8edf2")
ax.set_axisbelow(True)
ax.legend(loc="upper left", bbox_to_anchor=(0, 1.18), frameon=False, ncols=2, fontsize=10)
figure.text(0.02, 0.015, "Same 1M-user fixture · 22.89 MiB JSON · Node 26.12.0 · 5 fresh workers per method · no network or compression", fontsize=9, color="#596879")
figure.tight_layout(rect=(0, 0.05, 1, 1))
figure.savefig(directory / "matched-phases.png", dpi=180)
figure.savefig(directory / "matched-phases.svg")
