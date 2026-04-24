# loop-graph

Closed-loop path graph model with incidence matrix, edge geometry, and node-link export.

## Install

```bash
pip install -e .
```

## Quick start

```bash
python examples/quickstart.py
```

## Test

```bash
pytest
```

## Structure

```
src/loop_graph/
├── __init__.py
└── geometry.py      # ClosedLoopLayout, Node
data/
├── path_simple.csv  # 12 nodes, two groups
├── path_curved.csv  # 73 nodes, complex 3-D path
└── path_simple.json # Same simple data as node-link JSON
examples/
└── quickstart.py    # Load CSV → build graph → print properties
tests/
└── test_geometry.py # 16 tests
```

## API overview

| Class / function | Purpose |
|---|---|
| `Node(x, y, z, group, tags)` | A single point in 3-D space |
| `ClosedLoopLayout(nodes)` | Builds the closed-loop graph |
| `.incidence_matrix` | N×N incidence matrix B |
| `.edge_vectors()` | (N, 3) edge deltas |
| `.edge_lengths()` | (N,) Euclidean lengths |
| `.edge_horizontal_lengths()` | (N,) XY-plane lengths |
| `.adjacency_matrix()` | (N, N) directed adjacency |
| `.laplacian_matrix()` | Graph Laplacian D − A |
| `.group_nodes(group_id)` | Filter nodes by group |
| `.cumulative_elevation_profile()` | (N+1, 2) unrolled [distance, z] |
| `.to_node_link()` | NetworkX-compatible JSON dict |

## License

MIT
