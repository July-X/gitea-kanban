"""
Python port of vscode-git-graph algorithm (web/graph.ts).

Ground truth reference for comparison against our Go implementation.
Mirrors the exact semantics of Branch / Vertex / Graph classes in TS.

Input: list of (sha, parents[], is_stash), assumed to be in display order
(row 0 = topmost, i.e. latest / HEAD).
Output: dict keyed by sha with {row, lane, color, is_merge}, plus list of edges.
"""

from __future__ import annotations
from dataclasses import dataclass, field
from typing import List, Optional, Tuple, Dict, Iterable


NULL_VERTEX_ID = -1
DEFAULT_MAX_COLORS = 16


@dataclass
class Line:
    p1: Tuple[int, int]  # (x=lane, y=row)
    p2: Tuple[int, int]
    locked_first: bool


@dataclass
class Vertex:
    id: int
    is_stash: bool
    x: int = 0
    next_x: int = 0
    parents: List["Vertex"] = field(default_factory=list)
    children: List["Vertex"] = field(default_factory=list)
    next_parent: int = 0
    on_branch: Optional["Branch"] = None
    is_committed: bool = True
    is_current: bool = False
    connections: Dict[int, Tuple[Optional["Vertex"], "Branch"]] = field(default_factory=dict)


@dataclass
class Branch:
    colour: int
    end: int = 0
    lines: List[Line] = field(default_factory=list)
    num_uncommitted: int = 0

    def add_line(self, p1, p2, is_committed, locked_first):
        self.lines.append(Line(p1, p2, locked_first))
        if is_committed:
            if p2[0] == 0 and p2[1] < self.num_uncommitted:
                self.num_uncommitted = p2[1]
        else:
            self.num_uncommitted += 1


def _register_unavailable_point(v: Vertex, x: int, connects_to: Optional[Vertex], on_branch: "Branch"):
    if x == v.next_x:
        v.next_x = x + 1
        v.connections[x] = (connects_to, on_branch)


def _get_point_connecting_to(v: Vertex, vertex: Optional[Vertex], branch: "Branch") -> Optional[Tuple[int, int]]:
    for x, (c, b) in v.connections.items():
        if c is vertex and b is branch:
            return (x, v.id)
    return None


def _add_to_branch(v: Vertex, branch: Branch, x: int):
    if v.on_branch is None:
        v.on_branch = branch
        v.x = x


def _get_next_parent(v: Vertex) -> Optional[Vertex]:
    if v.next_parent < len(v.parents):
        return v.parents[v.next_parent]
    return None


def _is_merge(v: Vertex) -> bool:
    return len(v.parents) > 1


def _add_child(v: Vertex, c: Vertex):
    v.children.append(c)


def _add_parent(v: Vertex, p: Vertex):
    v.parents.append(p)


class GraphVscode:
    def __init__(self, max_colors: int = DEFAULT_MAX_COLORS):
        self.max_colors = max_colors
        self.sorted: List[Tuple[str, List[str], bool]] = []
        self.sha_to_row: Dict[str, int] = {}
        self.vertices: List[Vertex] = []
        self.branches: List[Branch] = []
        self.available_colours: List[int] = []

    def get_available_colour(self, start_at: int) -> int:
        for i, used_at in enumerate(self.available_colours):
            if start_at > used_at:
                return i
        self.available_colours.append(0)
        return len(self.available_colours) - 1

    def determine_path(self, start_at: int) -> None:
        vertex = self.vertices[start_at]
        parent_vertex = _get_next_parent(vertex)

        if vertex.on_branch is None:
            last_point = (vertex.next_x, vertex.id)
        else:
            last_point = (vertex.x, vertex.id)

        is_merge = _is_merge(vertex)
        parent_is_null = parent_vertex is not None and parent_vertex.id == NULL_VERTEX_ID
        can_do_merge_stitch = (
            parent_vertex is not None
            and not parent_is_null
            and is_merge
            and vertex.on_branch is not None
            and parent_vertex.on_branch is not None
        )

        if can_do_merge_stitch:
            found_point_to_parent = False
            parent_branch = parent_vertex.on_branch
            j = start_at + 1
            while j < len(self.vertices):
                cur_vertex = self.vertices[j]
                cur_point = _get_point_connecting_to(cur_vertex, parent_vertex, parent_branch)
                if cur_point is not None:
                    found_point_to_parent = True
                else:
                    cur_point = (cur_vertex.next_x, cur_vertex.id)
                locked_first = (
                    (not found_point_to_parent)
                    and cur_vertex is not parent_vertex
                    and last_point[0] < cur_point[0]
                )
                parent_branch.add_line(last_point, cur_point, vertex.is_committed, locked_first)
                _register_unavailable_point(cur_vertex, cur_point[0], parent_vertex, parent_branch)
                last_point = cur_point
                if found_point_to_parent:
                    vertex.next_parent += 1
                    break
                j += 1
            return

        # Normal: open a new branch
        branch = Branch(colour=self.get_available_colour(start_at))
        _add_to_branch(vertex, branch, last_point[0])
        _register_unavailable_point(vertex, last_point[0], vertex, branch)
        last_j = start_at
        j = start_at + 1
        while j < len(self.vertices):
            cur_vertex = self.vertices[j]
            if parent_vertex is cur_vertex and parent_vertex.on_branch is not None:
                cur_point = (cur_vertex.x, cur_vertex.id)
            else:
                cur_point = (cur_vertex.next_x, cur_vertex.id)
            branch.add_line(last_point, cur_point, vertex.is_committed, last_point[0] < cur_point[0])
            _register_unavailable_point(cur_vertex, cur_point[0], parent_vertex, branch)
            last_point = cur_point
            last_j = j
            if parent_vertex is cur_vertex:
                vertex.next_parent += 1
                parent_vertex_on_branch = parent_vertex.on_branch is not None
                _add_to_branch(parent_vertex, branch, cur_point[0])
                vertex = parent_vertex
                if vertex.next_parent < len(vertex.parents):
                    parent_vertex = vertex.parents[vertex.next_parent]
                else:
                    parent_vertex = None
                if parent_vertex is None or parent_vertex_on_branch:
                    break
            j += 1
        # If we ran off the end with a null parent, mark it as processed.
        if last_j == len(self.vertices) - 1 and parent_vertex is not None and parent_vertex.id == NULL_VERTEX_ID:
            vertex.next_parent += 1
        branch.end = last_j + 1
        self.branches.append(branch)
        self.available_colours[branch.colour] = branch.end

    def load_commits(self, commits: List[Tuple[str, List[str], bool]], head: str = "") -> None:
        if not commits:
            return
        # Stable sort by (sha, parents, is_stash) — Python's sort is stable
        # Caller is expected to pass commits in display order (row 0 = latest).
        self.sorted = list(commits)
        self.sha_to_row = {c[0]: i for i, c in enumerate(self.sorted)}

        self.vertices = [
            Vertex(id=i, is_stash=stash, connections={})
            for i, (_, _, stash) in enumerate(self.sorted)
        ]
        null_vertex = Vertex(id=NULL_VERTEX_ID, is_stash=False, connections={})
        null_vertex.next_x = -1

        for i, (sha, parents, _) in enumerate(self.sorted):
            for parent_sha in parents:
                if parent_sha in self.sha_to_row:
                    parent = self.vertices[self.sha_to_row[parent_sha]]
                    _add_parent(self.vertices[i], parent)
                    _add_child(parent, self.vertices[i])
                else:
                    _add_parent(self.vertices[i], null_vertex)

        if head and head in self.sha_to_row:
            self.vertices[self.sha_to_row[head]].is_current = True

        i = 0
        safety = 0
        max_iters = len(self.vertices) * 8 + 1
        while i < len(self.vertices):
            safety += 1
            if safety > max_iters:
                break
            v = self.vertices[i]
            np = _get_next_parent(v)
            if np is not None or v.on_branch is None:
                self.determine_path(i)
            else:
                i += 1

    def build_result(self) -> Tuple[Dict[str, dict], List[dict]]:
        """Return (info, edges) where:
          info: {sha: {row, lane, color, is_merge}}
          edges: [{from_row, to_row, from_lane, to_lane, color, type}]
        """
        info: Dict[str, dict] = {}
        max_lane = 0
        for i, (sha, parents, _) in enumerate(self.sorted):
            v = self.vertices[i]
            lane = v.x if v.on_branch is not None else 0
            if lane > max_lane:
                max_lane = lane
            color = v.on_branch.colour if v.on_branch is not None else 0
            info[sha] = {
                "row": i,
                "lane": lane,
                "color": color,
                "is_merge": len(parents) >= 2,
            }

        edges: List[dict] = []
        for i, (sha, parents, _) in enumerate(self.sorted):
            if not parents:
                continue
            child_row = i
            child_lane = info[sha]["lane"]
            child_color = info[sha]["color"]
            for p_sha in parents:
                if p_sha not in self.sha_to_row:
                    continue
                parent_row = self.sha_to_row[p_sha]
                p_info = info[p_sha]
                parent_lane = p_info["lane"]
                parent_color = p_info["color"]

                edge_type = "normal"
                if child_lane != parent_lane:
                    edge_type = "merge" if parent_lane > child_lane else "branch"

                edge_color = child_color
                if child_lane != parent_lane and parent_color == 0 and parent_row != 0:
                    edge_color = child_color

                edges.append({
                    "from_row": child_row,
                    "to_row": parent_row,
                    "from_lane": child_lane,
                    "to_lane": parent_lane,
                    "color": edge_color,
                    "type": edge_type,
                })

        return info, edges


def build_graph(commits: List[Tuple[str, List[str], bool]], head: str = "", max_colors: int = DEFAULT_MAX_COLORS):
    g = GraphVscode(max_colors=max_colors)
    g.load_commits(commits, head=head)
    return g.build_result()
