"""
跑一组综合测试 case, 每个 case:
  1. 构造一个 git 仓库 DAG
  2. 调 Go 端 BuildGraphVscode 输出 JSON
  3. 调 Python 端 build_graph 跑同样 commit 列表
  4. 对比 lane/color/edges

输出 PASS / FAIL 列表
"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

TOOLS = Path(__file__).parent
REPO_ROOT = TOOLS.parent.parent

from vscode_graph import build_graph  # noqa: E402


def run(cmd, cwd, env=None):
    e = os.environ.copy()
    if env:
        e.update(env)
    r = subprocess.run(cmd, cwd=cwd, env=e, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"cmd {cmd} failed in {cwd}: {r.stderr}")
    return r.stdout


def init_repo(path):
    run(["git", "init", "-b", "main", "-q"], path)
    run(["git", "config", "user.email", "a@b.c"], path)
    run(["git", "config", "user.name", "x"], path)


def commit(path, date, msg, files):
    for name, content in files.items():
        full = path + "/" + name
        os.makedirs(os.path.dirname(full), exist_ok=True) if "/" in name else None
        with open(full, "w") as f:
            f.write(content)
    run(["git", "add", "."], path)
    env = {
        "GIT_AUTHOR_DATE": date,
        "GIT_COMMITTER_DATE": date,
    }
    run(["git", "commit", "-m", msg, "-q"], path, env=env)


def branch(path, name):
    run(["git", "checkout", "-b", name, "-q"], path)


def checkout(path, name):
    run(["git", "checkout", name, "-q"], path)


def merge(path, src, msg, date):
    run(["git", "merge", "--no-ff", src, "-m", msg, "-q"], path, env={
        "GIT_AUTHOR_DATE": date,
        "GIT_COMMITTER_DATE": date,
    })


def run_go(repo, max_commits=0):
    cmd = ["go", "run", "./tools/vscode-recheck", repo]
    if max_commits:
        cmd.append(str(max_commits))
    r = subprocess.run(cmd, cwd=REPO_ROOT, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"go run failed: {r.stderr}")
    return json.loads(r.stdout)


def compare(go_data):
    commits_in = [(c['sha'], c.get('parents') or [], False) for c in go_data['commits']]
    head = go_data.get('meta', {}).get('head', '')
    vscode_info, vscode_edges = build_graph(commits_in, head=head)

    mismatches = 0
    for sha, vs in vscode_info.items():
        g = next((c for c in go_data['commits'] if c['sha'] == sha), None)
        if g is None:
            mismatches += 1
            continue
        if g['lane'] != vs['lane'] or g['color'] != vs['color']:
            mismatches += 1
    go_set = {(e['from_row'], e['to_row'], e['from_lane'], e['to_lane'], e['color'], e['type']) for e in go_data['edges']}
    vs_set = {(e['from_row'], e['to_row'], e['from_lane'], e['to_lane'], e['color'], e['type']) for e in vscode_edges}
    mismatches += len(go_set - vs_set) + len(vs_set - go_set)
    return mismatches


# ===== Test cases =====

def case_linear():
    with tempfile.TemporaryDirectory() as d:
        init_repo(d)
        for i in range(1, 8):
            commit(d, f"2026-01-0{i}T10:00:00Z", f"c{i}", {f"f{i}": str(i)})
        return run_go(d)


def case_branch_then_merge():
    with tempfile.TemporaryDirectory() as d:
        init_repo(d)
        commit(d, "2026-01-01T10:00:00Z", "c1", {"a": "1"})
        commit(d, "2026-01-02T10:00:00Z", "c2", {"a": "2"})
        branch(d, "feat")
        commit(d, "2026-01-03T10:00:00Z", "c3", {"b": "1"})
        commit(d, "2026-01-04T10:00:00Z", "c4", {"b": "2"})
        checkout(d, "main")
        merge(d, "feat", "merge feat", "2026-01-05T10:00:00Z")
        return run_go(d)


def case_octopus_merge():
    """3 个分支 merge 到 main"""
    with tempfile.TemporaryDirectory() as d:
        init_repo(d)
        commit(d, "2026-01-01T10:00:00Z", "c1", {"a": "1"})
        commit(d, "2026-01-02T10:00:00Z", "c2", {"a": "2"})
        for i, name in enumerate(["f1", "f2", "f3"]):
            branch(d, name)
            commit(d, f"2026-02-0{i+1}T10:00:00Z", f"c_{name}", {f"{name}.txt": "1"})
        checkout(d, "main")
        # sequential merge
        merge(d, "f1", "merge f1", "2026-03-01T10:00:00Z")
        merge(d, "f2", "merge f2", "2026-03-02T10:00:00Z")
        merge(d, "f3", "merge f3", "2026-03-03T10:00:00Z")
        return run_go(d)


def case_crossover():
    """branch A 和 branch B 都在中间 merge, 然后两边继续推进"""
    with tempfile.TemporaryDirectory() as d:
        init_repo(d)
        commit(d, "2026-01-01T10:00:00Z", "c1", {"a": "1"})
        commit(d, "2026-01-02T10:00:00Z", "c2", {"b": "1"})
        branch(d, "A")
        commit(d, "2026-01-03T10:00:00Z", "c3", {"a": "2"})
        commit(d, "2026-01-04T10:00:00Z", "c4", {"a": "3"})
        checkout(d, "main")
        commit(d, "2026-01-05T10:00:00Z", "c5", {"b": "2"})
        branch(d, "B")
        commit(d, "2026-01-06T10:00:00Z", "c6", {"b": "3"})
        commit(d, "2026-01-07T10:00:00Z", "c7", {"c": "1"})
        checkout(d, "main")
        merge(d, "B", "merge B", "2026-01-08T10:00:00Z")
        checkout(d, "A")
        commit(d, "2026-01-09T10:00:00Z", "c8", {"d": "1"})
        commit(d, "2026-01-10T10:00:00Z", "c9", {"d": "2"})
        checkout(d, "main")
        merge(d, "A", "merge A", "2026-01-11T10:00:00Z")
        return run_go(d)


def case_truncated():
    """MaxCount 截断,父节点不在可见列表中"""
    with tempfile.TemporaryDirectory() as d:
        init_repo(d)
        for i in range(1, 21):
            commit(d, f"2026-01-{i:02d}T10:00:00Z", f"c{i}", {f"f{i}": str(i)})
        return run_go(d, max_commits=8)


def case_shared_parent():
    """多个 commit 共享同一个 parent (创建多个 branch head 来自同一 commit)"""
    with tempfile.TemporaryDirectory() as d:
        init_repo(d)
        commit(d, "2026-01-01T10:00:00Z", "c1", {"a": "1"})
        # 3 个 branch 同时从 c1 开出
        for i, name in enumerate(["x", "y", "z"]):
            checkout(d, "main")
            branch(d, name)
            commit(d, f"2026-02-0{i+1}T10:00:00Z", f"c_{name}", {f"{name}.txt": "1"})
        checkout(d, "main")
        # 依次 merge
        for i, name in enumerate(["x", "y", "z"]):
            merge(d, name, f"merge {name}", f"2026-03-0{i+1}T10:00:00Z")
        return run_go(d)


def case_merge_then_branch():
    """merge 后立即从 merge 节点再分叉"""
    with tempfile.TemporaryDirectory() as d:
        init_repo(d)
        commit(d, "2026-01-01T10:00:00Z", "c1", {"a": "1"})
        commit(d, "2026-01-02T10:00:00Z", "c2", {"a": "2"})
        branch(d, "feat")
        commit(d, "2026-01-03T10:00:00Z", "c3", {"b": "1"})
        checkout(d, "main")
        merge(d, "feat", "merge feat", "2026-01-04T10:00:00Z")
        # 在 merge 节点后再开一个 branch
        branch(d, "feat2")
        commit(d, "2026-01-05T10:00:00Z", "c5", {"c": "1"})
        checkout(d, "main")
        merge(d, "feat2", "merge feat2", "2026-01-06T10:00:00Z")
        return run_go(d)


CASES = [
    ("linear", case_linear),
    ("branch_then_merge", case_branch_then_merge),
    ("octopus_merge", case_octopus_merge),
    ("crossover", case_crossover),
    ("truncated", case_truncated),
    ("shared_parent", case_shared_parent),
    ("merge_then_branch", case_merge_then_branch),
]


def main():
    total_fail = 0
    for name, fn in CASES:
        try:
            data = fn()
            n_commits = len(data['commits'])
            n_edges = len(data['edges'])
            n_mismatch = compare(data)
            status = "PASS" if n_mismatch == 0 else f"FAIL ({n_mismatch} mismatches)"
            print(f"  [{status}] {name:<25} commits={n_commits:<3} edges={n_edges}")
            if n_mismatch > 0:
                total_fail += 1
        except Exception as e:
            print(f"  [ERROR] {name:<25} {e}")
            total_fail += 1
    print()
    print(f"=== {len(CASES) - total_fail}/{len(CASES)} passed ===")
    sys.exit(0 if total_fail == 0 else 1)


if __name__ == "__main__":
    main()
