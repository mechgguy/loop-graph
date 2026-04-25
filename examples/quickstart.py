"""Quickstart: load CSV data, build a closed-loop graph, inspect properties."""

import csv
from pathlib import Path

from loop_graph import ClosedLoopLayout, Node

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def load_csv(path: Path) -> list[Node]:
    """Load nodes from a CSV file into a list of Node objects."""
    nodes = []
    with open(path, newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            tags = [t for t in row.get("tags", "").split(";") if t]
            nodes.append(Node(
                x=float(row["x"]),
                y=float(row["y"]),
                z=float(row["z"]),
                group=int(row["group"]),
                tags=tags,
            ))
    return nodes


def main() -> None:
    csv_path = DATA_DIR / "path_simple.csv"
    nodes = load_csv(csv_path)

    print(f"Loaded {len(nodes)} nodes from {csv_path.name}")
    g0 = [n for n in nodes if n.group == 0]
    g1 = [n for n in nodes if n.group == 1]
    print(f"  Group 0: {len(g0)}, Group 1: {len(g1)}")
    print()

    layout = ClosedLoopLayout(nodes)

    print(f"Incidence matrix shape: {layout.incidence_matrix.shape}")
    lengths = layout.edge_lengths()
    print(f"Edges: {len(lengths)}")
    print()

    print("Edge lengths (euclidean):")
    for i, length in enumerate(lengths):
        print(f"  Edge {i}: {length:.1f}")
    print()

    profile = layout.cumulative_elevation_profile()
    print("Cumulative elevation profile:")
    for i, (h, z) in enumerate(profile):
        print(f"  Point {i}: horizontal={h:.1f}, z={z:.1f}")
    print()

    A = layout.adjacency_matrix()
    print(f"Adjacency matrix (non-zero entries): {int(A.sum())}")
    print(f"Graph: {layout.incidence_matrix.shape[0]} nodes, {layout.incidence_matrix.shape[1]} edges")
    print()

    import json
    node_link = layout.to_node_link()
    print(f"Node-link export: {len(node_link['nodes'])} nodes, {len(node_link['links'])} links")


if __name__ == "__main__":
    main()
