#!/usr/bin/env python3
"""生成 vscode-git-graph 真实 SVG + 我的 SVG 的 side-by-side HTML
(同样的 30 commit DeepSeek-Reasonix, 同样 config grid 16x24 + colors)"""

import json, re, html as html_mod

# 读 vscode 真实 branches
vs = json.load(open('/tmp/vscode-graph-out.json'))

# 读我的 Go 输出
m = re.search(r'<pre class="json">(.*?)</pre>', open('/tmp/debug-vscode.html').read(), re.DOTALL)
go = json.loads(html_mod.unescape(m.group(1)))

GRID_X, GRID_Y = 16, 24
OFFSET_X, OFFSET_Y = 16, 12
EXPAND_Y = 250
VSCODE_COLORS = ['#0085d9', '#d9008f', '#00d90a', '#d98500', '#a300d9',
                 '#ff0000', '#00d9cc', '#e138e8', '#85d900', '#dc5b23',
                 '#6f24d6', '#ffcc00']

def render_svg(branches, vertices, title, head_id, max_lane, vertex_count):
    """完整复刻 vscode Branch.draw + Vertex.draw:
    - 每条 path 画 shadow (粗 4px 半透明) + line (细 2px)
    - HEAD 节点空心 circle
    - 普通 dot 有 1px 描边"""
    paths_svg = []
    dots_svg = []

    # 简化共线 (vscode Branch.draw:106-116)
    # 每个 branch: 把 lines 中 (last.p2 == next.p1) 的相邻 line 合并
    for b in branches:
        col = b.get('colour', b.get('color'))
        lines = b.get('lines', [])
        # 坐标转像素
        placed = []
        for ln in lines:
            if 'p1' in ln:  # vscode 格式
                x1, y1 = ln['p1']['x']*GRID_X+OFFSET_X, ln['p1']['y']*GRID_Y+OFFSET_Y
                x2, y2 = ln['p2']['x']*GRID_X+OFFSET_X, ln['p2']['y']*GRID_Y+OFFSET_Y
                lf = ln['lockedFirst']
            else:  # 我的格式
                x1, y1 = ln['x1']*GRID_X+OFFSET_X, ln['y1']*GRID_Y+OFFSET_Y
                x2, y2 = ln['x2']*GRID_X+OFFSET_X, ln['y2']*GRID_Y+OFFSET_Y
                lf = ln['locked_first']
            placed.append((x1, y1, x2, y2, lf))
        # 简化: 同 column 直线合并
        simplified = []
        for seg in placed:
            last = simplified[-1] if simplified else None
            if last and last[0]==last[2] and last[2]==seg[0] and seg[0]==seg[2] and last[3]==seg[1]:
                # 同列直线 + last.p2.y == seg.p1.y → 合并
                simplified[-1] = (last[0], last[1], seg[2], seg[3], last[4])
            else:
                simplified.append(list(seg))
        # 拼 path d (C 贝塞尔 dy=GRID_Y*0.8=19.2)
        d = ''
        cur_path = ''
        for i, seg in enumerate(simplified):
            x1, y1, x2, y2, lf = seg
            if i == 0 or (i > 0 and cur_path and (simplified[i-1][2] != x1 or simplified[i-1][3] != y1)):
                if cur_path:
                    paths_svg.append((col, cur_path))
                cur_path = f'M {x1:.0f} {y1:.1f}'
            if x1 == x2:
                cur_path += f' L {x2:.0f} {y2:.1f}'
            else:
                curve_dy = GRID_Y * 0.8
                cur_path += f' C {x1:.0f} {(y1+curve_dy):.1f} {x2:.0f} {(y2-curve_dy):.1f} {x2:.0f} {y2:.1f}'
        if cur_path:
            paths_svg.append((col, cur_path))

    # Vertex.draw: 每个 dot = r=4 circle, HEAD 空心
    for v in vertices:
        cx = v['x']*GRID_X + OFFSET_X
        cy = v['id']*GRID_Y + OFFSET_Y  # vertex.id == row
        is_head = v.get('isCurrent', v.get('is_current', False))
        is_stash = v.get('isStash', v.get('is_stash', False))
        col_hex = VSCODE_COLORS[v.get('colour', v.get('color', 0)) % 12]
        if is_head:
            dots_svg.append(f'<circle cx="{cx}" cy="{cy}" r="4" fill="#fff" stroke="{col_hex}" stroke-width="2"/>')
        elif is_stash:
            dots_svg.append(f'<circle cx="{cx}" cy="{cy}" r="4.5" fill="none" stroke="{col_hex}" stroke-width="1"/>')
            dots_svg.append(f'<circle cx="{cx}" cy="{cy}" r="2" fill="none" stroke="{col_hex}" stroke-width="1"/>')
        else:
            dots_svg.append(f'<circle cx="{cx}" cy="{cy}" r="4" fill="{col_hex}" stroke="#fff" stroke-width="1" stroke-opacity="0.75"/>')

    # 拼完整 SVG (每条 path 画 shadow + line)
    width = 2*OFFSET_X + max_lane*GRID_X + GRID_X
    height = vertex_count*GRID_Y + OFFSET_Y - GRID_Y//2
    svg = f'<svg width="{width}" height="{height}" viewBox="0 0 {width} {height}" xmlns="http://www.w3.org/2000/svg">'
    for col, d in paths_svg:
        col_hex = VSCODE_COLORS[col % 12]
        svg += f'<path d="{d}" stroke="#000" stroke-opacity="0.75" stroke-width="4" fill="none" stroke-linecap="round"/>'
        svg += f'<path d="{d}" stroke="{col_hex}" stroke-width="2" fill="none" stroke-linecap="round"/>'
    for d_svg in dots_svg:
        svg += d_svg
    svg += '</svg>'
    return svg

# 构造 vscode 顶点 (从 branches 反推 - 但 vscode vertex 还有 id+nextX)
# 实际上 vscode vertex list 直接来自 driver_real.ts 的输出,包含 x 和 id
# 让我重新提取 vertex 列表

# vertex list: 我们的数据是 [{id, x, nextX, ...}]
vs_vertices = vs['vertices']
go_vertices = [{'id': c['row'], 'x': c['lane'], 'colour': c['color'], 'isCurrent': False, 'isStash': False} for c in go['commits']]
# 找 HEAD: 第一个 commit (row=0)
go_vertices[0]['isCurrent'] = True
# vscode 真实: vertex[head_id].isCurrent = true. 第一个 = HEAD (row=0)
vs_vertices[0]['isCurrent'] = True

vs_svg = render_svg(vs['branches'], vs_vertices, "vscode-git-graph (真实 TS 算法)", 0, vs.get('maxLane', 4), len(vs_vertices))
go_svg = render_svg(go['branches'], go_vertices, "我的 Go BuildGraphVscode (移植实现)", 0, go['max_lane'], len(go_vertices))

# 拼 HTML (暗色背景更接近 vscode 主题)
html_out = f'''<!DOCTYPE html>
<html><head>
<style>
  body {{ background: #1e1e1e; color: #d4d4d4; font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 0; padding: 20px; }}
  .row {{ display: flex; gap: 20px; align-items: flex-start; }}
  .col {{ flex: 1; background: #252526; padding: 16px; border-radius: 4px; }}
  .col h2 {{ margin: 0 0 12px 0; font-size: 14px; color: #d4d4d4; }}
  svg {{ display: block; background: #1e1e1e; }}
</style>
</head><body>
<h1 style="margin-top:0">vscode-git-graph 真实算法 vs 我的 Go 移植 (30 commit DeepSeek-Reasonix)</h1>
<div class="row">
  <div class="col">
    <h2>左: vscode-git-graph 真实 TS 算法 ({vs.get("branchCount")} branches)</h2>
    {vs_svg}
  </div>
  <div class="col">
    <h2>右: 我的 Go BuildGraphVscode ({len(go['branches'])} branches)</h2>
    {go_svg}
  </div>
</div>
</body></html>'''

open('/tmp/vscode-vs-go.html', 'w').write(html_out)
print('wrote /tmp/vscode-vs-go.html, size:', len(html_out), 'bytes')
print('vscode branches:', vs.get('branchCount'), '| go branches:', len(go['branches']))
print('vscode svg height:', len(vs_vertices)*24 + 12)
print('go svg height:', len(go_vertices)*24 + 12)