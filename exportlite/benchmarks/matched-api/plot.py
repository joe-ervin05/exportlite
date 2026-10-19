"""Render a scientific phase comparison from the recorded worker summary."""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator

root = Path(__file__).resolve().parent
output = root.parent / "results" / "matched-api"
summary = json.loads((output / "summary.json").read_text())
methods = ["sqlite", "exportlite", "manual", "drizzle"]
labels = ["Full SQLite", "ExportLite\n256 roots", "Manual JS", "Drizzle"]
titles = ["Users", "Users → posts", "Users → posts → comments"]
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11,
    "axes.spines.top": False, "axes.spines.right": False,
    "axes.edgecolor": "#CBD5E1", "text.color": "#172033",
    "axes.labelcolor": "#334155", "xtick.color": "#475569", "ytick.color": "#475569",
    "svg.fonttype": "none", "savefig.facecolor": "white"})
fig, axes = plt.subplots(1, 3, figsize=(15.5, 6.2))
for depth, axis in enumerate(axes):
    row = next(r for r in summary["cases"] if r["roots"] == 1_000_000 and r["depth"] == depth)
    stats = [row["methods"][method] for method in methods]
    generation = [s["generationMs"] for s in stats]
    encoding = [s["encodingMs"] for s in stats]
    axis.set_axisbelow(True)
    axis.grid(axis="y", color="#E2E8F0", linewidth=0.7)
    axis.bar(range(4), generation, color="#2878A6", label="JSON generation / pipeline", width=0.66)
    axis.bar(range(4), encoding, bottom=generation, color="#E69F00", label="UTF-8 encoding", width=0.66)
    axis.errorbar(range(4), [s["totalMs"] for s in stats],
        yerr=[[s["totalMs"] - s["minMs"] for s in stats], [s["maxMs"] - s["totalMs"] for s in stats]],
        fmt="none", ecolor="#334155", capsize=3, linewidth=1)
    for index, stat in enumerate(stats):
        axis.text(index, stat["maxMs"] * 1.015, f'{stat["totalMs"]:,.0f}', ha="center", va="bottom", fontsize=10)
    axis.set_ylim(0, max(s["maxMs"] for s in stats) * 1.14)
    axis.yaxis.set_major_locator(MaxNLocator(nbins=5))
    axis.set_xticks(range(4), labels)
    axis.set_title(f'{titles[depth]}\n{row["totalRecords"] / 1_000_000:g}m records · {row["bytes"] / 1_048_576:.1f} MiB', fontsize=12, loc="left", pad=14)
    axis.set_ylabel("Response production, ms")
fig.suptitle("Matched fixture and runtime: where response time goes", x=0.055, y=0.98, ha="left", fontsize=19, fontweight="bold")
fig.text(0.055, 0.905, "One million root users · Node 26.12.0 · identical JSON bytes · separate linear time range per panel", fontsize=11, color="#475569")
handles, legend_labels = axes[0].get_legend_handles_labels()
fig.legend(handles, legend_labels, loc="lower left", bbox_to_anchor=(0.05, 0.13), ncol=2, frameon=False)
fig.text(0.055, 0.09, "Medians of 3 fresh workers; whiskers show process min–max. Generation includes producer coordination.", fontsize=10, color="#475569")
fig.text(0.055, 0.045, "Prepared 256-root ExportLite adapter for nested/limited queries; no network, disk, compression or client parsing.", fontsize=9.5, color="#64748B")
fig.subplots_adjust(left=0.055, right=0.985, top=0.77, bottom=0.28, wspace=0.28)
for extension in ["png", "svg"]:
    fig.savefig(output / f"phases.{extension}", dpi=170)
plt.close(fig)
print(json.dumps({"matplotlib": matplotlib.__version__, "output": str(output / "phases.png")}))
