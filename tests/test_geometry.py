"""Smoke tests for the closed-loop graph model."""

import numpy as np
import pytest

from loop_graph import ClosedLoopLayout, Node


@pytest.fixture
def simple_layout() -> ClosedLoopLayout:
    """A minimal closed loop: 3 nodes in group 0 + 3 in group 1."""
    return ClosedLoopLayout([
        Node(0, 0, 0, 0, ["start"]),
        Node(100, 0, 5, 0),
        Node(200, 0, 10, 0, ["end"]),
        Node(200, 0, 8, 1),
        Node(100, 0, 3, 1),
        Node(0, 0, 0, 1, ["anchor"]),
    ])


class TestNode:
    def test_coords(self) -> None:
        n = Node(1.0, 2.0, 3.0)
        assert list(n.coords()) == [1.0, 2.0, 3.0]

    def test_default_group(self) -> None:
        n = Node(0, 0, 0)
        assert n.group == 0

    def test_tags(self) -> None:
        n = Node(0, 0, 0, tags=["start", "junction"])
        assert n.tags == ["start", "junction"]


class TestIncidenceMatrix:
    def test_shape(self, simple_layout: ClosedLoopLayout) -> None:
        B = simple_layout.incidence_matrix
        assert B.shape == (6, 6), "Closed loop: n_nodes == n_edges"

    def test_column_sums_zero(self, simple_layout: ClosedLoopLayout) -> None:
        """Each column has exactly one -1 and one +1."""
        assert np.allclose(simple_layout.incidence_matrix.sum(axis=0), 0)


class TestEdges:
    def test_count(self, simple_layout: ClosedLoopLayout) -> None:
        assert len(simple_layout.edge_lengths()) == 6

    def test_non_negative(self, simple_layout: ClosedLoopLayout) -> None:
        assert (simple_layout.edge_lengths() >= 0).all()

    def test_vectors_shape(self, simple_layout: ClosedLoopLayout) -> None:
        v = simple_layout.edge_vectors()
        assert v.shape == (6, 3)


class TestGraphMatrices:
    def test_adjacency_edges(self, simple_layout: ClosedLoopLayout) -> None:
        A = simple_layout.adjacency_matrix()
        assert A.sum() == 6  # 6 directed edges

    def test_laplacian_row_sum(self, simple_layout: ClosedLoopLayout) -> None:
        L = simple_layout.laplacian_matrix()
        assert np.allclose(L.sum(axis=1), 0)


class TestGroupNodes:
    def test_group_0_count(self, simple_layout: ClosedLoopLayout) -> None:
        assert len(simple_layout.group_nodes(0)) == 3

    def test_group_1_count(self, simple_layout: ClosedLoopLayout) -> None:
        assert len(simple_layout.group_nodes(1)) == 3


class TestElevationProfile:
    def test_shape(self, simple_layout: ClosedLoopLayout) -> None:
        profile = simple_layout.cumulative_elevation_profile()
        assert profile.shape[1] == 2
        assert profile.shape[0] == 7  # N+1 for closed loop

    def test_starts_at_zero(self, simple_layout: ClosedLoopLayout) -> None:
        profile = simple_layout.cumulative_elevation_profile()
        assert profile[0, 0] == 0.0


class TestNodeLinkExport:
    def test_structure(self, simple_layout: ClosedLoopLayout) -> None:
        nl = simple_layout.to_node_link()
        assert len(nl["nodes"]) == 6
        assert len(nl["links"]) == 6
        assert nl["directed"] is True

    def test_tags_preserved(self, simple_layout: ClosedLoopLayout) -> None:
        nl = simple_layout.to_node_link()
        assert "start" in nl["nodes"][0]["tags"]
        assert "end" in nl["nodes"][2]["tags"]
