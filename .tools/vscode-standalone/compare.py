#!/usr/bin/env python3
"""对比 vscode-git-graph 真实 TS 算法输出 vs 我的 Go BuildGraphVscode 输出
按 (colour, lines fingerprint) 配对, 检查 line 坐标是否一致"""

import json, sys
from collections import defaultdict

def load(p):
    return json.load(open(p))

def fingerprint(b):
    """把 branch 转成可比较的 (lines)"""
    return [(ln['p1']['x'], ln['p1']['y'], ln['p2']['x'], ln['p2']['y'], ln['lockedFirst'])
            if 'p1' in ln else
            (ln['x1'], ln['y1'], ln['x2'], ln['y2'], ln['locked_first'])
            for ln in b['lines']]

vs = load('/tmp/vscode-graph-out.json')
go = None  # placeholder

import re, html as html_mod
s = open('/tmp/debug-vscode.html').read()
m = re.search(r'<pre class="json">(.*?)</pre>', s, re.DOTALL)
go = json.loads(html_mod.unescape(m.group(1)))

# vscode 输出 branch.lines 是 [{p1,p2,lockedFirst}], 我的是 [{x1,y1,x2,y2,locked_first}]
# 统一格式后按 (colour, lines 列表) 排序对比
def normalise(b):
    return {
        'colour': b.get('colour', b.get('color')),
        'end': b['end'],
        'lines': fingerprint(b),
    }

vs_brs = sorted([normalise(b) for b in vs['branches']], key=lambda x: (x['colour'], x['end']))
go_brs = sorted([normalise(b) for b in go['branches']], key=lambda x: (x['colour'], x['end']))

print(f'vscode: {len(vs_brs)} branches')
print(f'go    : {len(go_brs)} branches')

# 按 colour 分组比较
vs_by_colour = defaultdict(list)
go_by_colour = defaultdict(list)
for b in vs_brs: vs_by_colour[b['colour']].append(b)
for b in go_brs: go_by_colour[b['colour']].append(b)

print(f'\n{"color":<6}{"vscode#":<8}{"go#":<6}{"match":<6}{"diff"}')
for colour in sorted(set(vs_by_colour) | set(go_by_colour)):
    vsb = vs_by_colour.get(colour, [])
    gob = go_by_colour.get(colour, [])
    match = len(vsb) == len(gob)
    print(f'{colour:<6}{len(vsb):<8}{len(gob):<6}{"✓" if match else "✗":<6}')

# 详细 diff
print('\n=== line-by-line diff per branch ===')
for colour in sorted(set(vs_by_colour) | set(go_by_colour)):
    vsb = sorted(vs_by_colour.get(colour, []), key=lambda x: x['end'])
    gob = sorted(go_by_colour.get(colour, []), key=lambda x: x['end'])
    for i in range(max(len(vsb), len(gob))):
        vb = vsb[i] if i < len(vsb) else None
        gb = gob[i] if i < len(gob) else None
        if vb is None:
            print(f'  color={colour} branch {i}: GO-ONLY ({len(gb["lines"])} lines)')
            continue
        if gb is None:
            print(f'  color={colour} branch {i}: VSCODE-ONLY ({len(vb["lines"])} lines)')
            continue
        if vb['lines'] == gb['lines']:
            print(f'  color={colour} branch {i}: MATCH ({len(vb["lines"])} lines, end={vb["end"]})')
        else:
            print(f'  color={colour} branch {i}: DIFF (vscode={len(vb["lines"])} lines end={vb["end"]} | go={len(gb["lines"])} lines end={gb["end"]})')
            # Show first diff
            for j, (l, r) in enumerate(zip(vb['lines'], gb['lines'])):
                if l != r:
                    print(f'    line {j}: vscode={l} | go={r}')
                    break