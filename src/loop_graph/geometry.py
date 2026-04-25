"""
Closed-loop path as a graph: nodes connected by edges.

The graph is represented by an **incidence matrix** B (standard graph theory):
- B[i, j] = -1  →  node i is the START of edge j
- B[i, j] = +1  →  node i is the END of edge j

All edge geometry (lengths, angles, profile) is derived from the node
coordinates and the incidence matrix.  Moving a node automatically updates
every edge that touches it.

The path forms a directed closed loop.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


# ---------------------------------------------------------------------------
# Node
# ---------------------------------------------------------------------------

@dataclass
class Node:
    """A single point (node) on the path."""

    x: float
    y: float
    z: float
    group: int = 0
    tags: list[str] = field(default_factory=list)

    def coords(self) -> np.ndarray:
        """Return [x, y, z] as a NumPy array."""
        return np.array([self.x, self.y, self.z])


# ---------------------------------------------------------------------------
# ClosedLoopLayout — the graph model
# ---------------------------------------------------------------------------

class ClosedLoopLayout:
    """Graph model for a closed-loop path through 3-D space.

    Parameters
    ----------
    nodes : list[Node]
        Ordered list of nodes.

    Example
    -------
    >>> ns = [
    ...     Node(0, 0, 0, 0, ["start"]),
    ...     Node(100, 0, 5, 0),
    ...     Node(200, 50, 10, 0, ["end"]),
    ...     Node(200, 50, 8, 1),
    ...     Node(100, 0, 3, 1),
    ...     Node(0, 0, 0, 1, ["anchor"]),
    ... ]
    >>> layout = ClosedLoopLayout(ns)
    >>> layout.incidence_matrix.shape
    (6, 6)
    """

    def __init__(self, nodes: list[Node]) -> None:
        self.nodes = list(nodes)

    # -- coordinates as arrays -----------------------------------------------

    def coords(self) -> np.ndarray:
        """(N, 3) array of [x, y, z] for every node."""
        return np.array([n.coords() for n in self.nodes])

    def groups(self) -> np.ndarray:
        """(N,) int array of group flags."""
        return np.array([n.group for n in self.nodes])

    # -- incidence matrix ----------------------------------------------------

    @property
    def incidence_matrix(self) -> np.ndarray:
        """Closed-loop incidence matrix (N×N for N nodes / N edges).

        Edge j connects node j → node (j+1) % N.
        """
        n = len(self.nodes)
        B = np.zeros((n, n))
        for i in range(n):
            B[i, i] = -1
            B[(i + 1) % n, i] = 1
        # print(f'Incidence Matrix:\n',B)
        return B

    # -- edge geometry -------------------------------------------------------

    def edge_vectors(self) -> np.ndarray:
        """(N, 3) array of edge deltas [dx, dy, dz], derived from coords @ B."""
        return (self.coords().T @ self.incidence_matrix).T

    def edge_lengths(self) -> np.ndarray:
        """(N,) Euclidean length of each edge."""
        return np.linalg.norm(self.edge_vectors(), axis=1)

    def edge_horizontal_lengths(self) -> np.ndarray:
        """(N,) Horizontal (XY-plane) length of each edge."""
        v = self.edge_vectors()
        return np.linalg.norm(v[:, :2], axis=1)

    # -- derived matrices ----------------------------------------------------

    def adjacency_matrix(self) -> np.ndarray:
        """(N, N) adjacency matrix (directed)."""
        B = self.incidence_matrix
        n = B.shape[0]
        A = np.zeros((n, n))
        for s in range(B.shape[1]):
            i = int(np.where(B[:, s] == -1)[0][0])
            j = int(np.where(B[:, s] == 1)[0][0])
            A[i, j] = 1
        # print(f'Adjancency Matrix:\n',A)
        return A

    def laplacian_matrix(self) -> np.ndarray:
        """Graph Laplacian D − A."""
        A = self.adjacency_matrix()
        print (f'Adjacency Matrix:\n',A)
        return np.diag(A.sum(axis=1)) - A

    # -- group helpers -------------------------------------------------------

    def group_nodes(self, group_id: int) -> list[Node]:
        """Return all nodes belonging to a given group."""
        return [n for n in self.nodes if n.group == group_id]

    # -- cumulative elevation profile ----------------------------------------

    def cumulative_elevation_profile(self) -> np.ndarray:
        """(N+1, 2) array of [cumulative_horizontal_distance, z].

        Horizontal curves are unrolled into straight horizontal distance
        while the Z (elevation) profile is preserved.  The profile has N+1
        points because the last edge wraps back to the first node.
        """
        h_lens = self.edge_horizontal_lengths()
        cum_h = np.concatenate([[0.0], np.cumsum(h_lens)])
        zs = np.array([n.z for n in self.nodes])
        z_profile = np.concatenate([zs, [zs[0]]])
        return np.column_stack([cum_h, z_profile])

    # -- node-link export (NetworkX-compatible) ------------------------------

    def to_node_link(self) -> dict:
        """Export the layout as a node-link JSON dict.

        Compatible with ``networkx.node_link_graph()`` for import.
        """
        nodes = []
        for i, n in enumerate(self.nodes):
            nodes.append({
                "id": i, "x": n.x, "y": n.y, "z": n.z,
                "group": n.group, "tags": n.tags,
            })
        links = []
        for i in range(len(self.nodes)):
            links.append({"source": i, "target": (i + 1) % len(self.nodes)})
        return {
            "directed": True,
            "multigraph": False,
            "nodes": nodes,
            "links": links,
        }
