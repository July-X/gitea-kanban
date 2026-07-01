"""
对比工具: 读 Go 端 BuildGraphVscode 输出和 Python 端 vscode 参考实现的输出,
逐 row 对比 lane/color/edges。

用法:
    python3 tools/vscode-recheck/compare.py go-result.json
"""

import json
import sys
from typing import Dict, List, Tuple

from vscode_graph import build_graph


def load_go(path: str) -> dict:
    with open(path) as f:
        return json.load(f)


def run_vscode_ref(go_data: dict) -> Tuple[Dict[str, dict], List[dict]]:
    commits_in = []
    for c in go_data['commits']:
        parents = c.get('parents') or []
        commits_in.append((c['sha'], parents, False))
    head = go_data.get('meta', {}).get('head', '')
    return build_graph(commits_in, head=head)


def diff(go: dict, vscode_info: Dict[str, dict], vscode_edges: List[dict]) -> Tuple[int, str]:
    """逐 row 对比 lane/color, 返回 (mismatch_count, report)"""
    lines: List[str] = []
    lines.append(f"{'row':<4} {'sha':<8} {'go_lane':<8} {'vs_lane':<8} {'go_col':<6} {'vs_col':<6} {'status'}")
    mismatches = 0
    go_commits = {c['sha']: c for c in go['commits']}
    for sha, vs_info in vscode_info.items():
        g = go_commits.get(sha)
        if g is None:
            lines.append(f"     {sha[:7]:<8} {'-':<8} {vs_info['lane']:<8} {'-':<6} {vs_info['color']:<6} MISSING-IN-GO")
            mismatches += 1
            continue
        gl, gc = g['lane'], g['color']
        vl, vc = vs_info['lane'], vs_info['color']
        if gl != vl or gc != vc:
            status = "MISMATCH"
            mismatches += 1
        else:
            status = "ok"
        lines.append(f"{vs_info['row']:<4} {sha[:7]:<8} {gl:<8} {vl:<8} {gc:<6} {vc:<6} {status}")

    # Edge comparison
    lines.append("")
    lines.append(f"--- edges: go={len(go['edges'])} vscode={len(vscode_edges)} ---")
    go_edge_set = {
        (e['from_row'], e['to_row'], e['from_lane'], e['to_lane'], e['color'], e['type'])
        for e in go['edges']
    }
    vs_edge_set = {
        (e['from_row'], e['to_row'], e['from_lane'], e['to_lane'], e['color'], e['type'])
        for e in vscode_edges
    }
    only_go = go_edge_set - vs_edge_set
    only_vs = vs_edge_set - go_edge_set
    for e in sorted(only_go):
        lines.append(f"  GO-ONLY: {e}")
    for e in sorted(only_vs):
        lines.append(f"  VS-ONLY: {e}")
    if only_go or only_vs:
        mismatches += len(only_go) + len(only_vs)

    return mismatches, "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print("usage: compare.py go-result.json", file=sys.stderr)
        sys.Exit = sys.exit
        sys.exit(2)
    go_path = sys.argv[1]
    go_data = load_go(go_path)
    vscode_info, vscode_edges = run_vscode_ref(go_data)
    n, report = diff(go_data, vscode_info, vscode_edges)
    print(report)
    print()
    print(f"=== TOTAL MISMATCHES: {n} ===")
    sys.exit(1 if n > 0 else 0)


if __name__ == "__main__":
    main()
