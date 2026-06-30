import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as patches

fig, ax = plt.subplots(figsize=(6, 4), constrained_layout=True)
ax.set_xlim(0, 10)
ax.set_ylim(0, 6)
ax.set_facecolor("#fef3c7")
ax.axis("off")

# Title
ax.text(5, 5.2, "Q1 2024 Sales by Region", ha="center", fontsize=18, weight="bold", color="#1f2937")

# Bars
regions = ["North", "South", "East", "West"]
values = [320, 250, 410, 180]
colors = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444"]
bars = ax.bar(regions, values, color=colors, edgecolor="white", linewidth=2)
for bar, v in zip(bars, values):
    ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 10,
            f"${v}k", ha="center", fontsize=12, weight="bold")

ax.set_ylim(0, 480)
ax.text(5, 0.3, "Total: $1,160k  ·  Growth: +18% YoY",
        ha="center", fontsize=11, color="#6b7280", style="italic")

fig.patch.set_facecolor("white")
plt.savefig("/home/z/my-project/scripts/test-chart.png", dpi=100, facecolor="white")
print("Saved test-chart.png")
