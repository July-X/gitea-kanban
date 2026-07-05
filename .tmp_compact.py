#!/usr/bin/env python3
"""v0.7.4 紧凑化 + 强化 git-graph-header sticky 视觉反馈"""

PATH_COMPONENT = 'frontend/src/components/GitCommitHeatmap.vue'
PATH_VIEW = 'frontend/src/views/TimelineNewView.vue'

# ============================================================
# 1. GitCommitHeatmap.vue：缩减 padding/margin
# ============================================================
with open(PATH_COMPONENT, 'r', encoding='utf-8') as f:
    content = f.read()

# 1.1 .commit-heatmap padding 紧凑
content = content.replace(
    '  padding: var(--space-3, 12px) var(--space-4, 16px);\n  background: transparent;\n  color: var(--color-text);',
    '  padding: var(--space-2, 8px) var(--space-3, 12px);\n  background: transparent;\n  color: var(--color-text);',
    1,
)
print('[OK] .commit-heatmap padding: 12/16 → 8/12')

# 1.2 .commit-heatmap__top-line margin-bottom 紧凑
content = content.replace(
    '  margin-bottom: var(--space-2, 8px);\n}\n\n/* periodLabel',
    '  margin-bottom: 2px;\n}\n\n/* periodLabel',
    1,
)
print('[OK] .commit-heatmap__top-line margin-bottom: 8 → 2')

# 1.3 .commit-heatmap__body gap 紧凑
content = content.replace(
    '.commit-heatmap__body {\n  display: flex;\n  align-items: flex-start;\n  gap: var(--space-2, 8px);\n  min-height: 0;\n  flex-shrink: 0;\n}',
    '.commit-heatmap__body {\n  display: flex;\n  align-items: flex-start;\n  gap: 6px;\n  min-height: 0;\n  flex-shrink: 0;\n}',
    1,
)
print('[OK] .commit-heatmap__body gap: 8 → 6')

# 1.4 .commit-heatmap__legend margin-top 紧凑
content = content.replace(
    '.commit-heatmap__legend {\n  display: flex;\n  align-items: center;\n  gap: var(--space-1, 4px);\n  margin-top: var(--space-2, 8px);\n  font-size: var(--font-xs, 11px);\n  color: var(--color-text-muted);\n}',
    '.commit-heatmap__legend {\n  display: flex;\n  align-items: center;\n  gap: var(--space-1, 4px);\n  margin-top: 4px;\n  font-size: var(--font-xs, 11px);\n  color: var(--color-text-muted);\n}',
    1,
)
print('[OK] .commit-heatmap__legend margin-top: 8 → 4')

# 1.5 .timeline-new__heatmap-sticky padding 紧凑（在 TimelineNewView.vue 中）
with open(PATH_VIEW, 'r', encoding='utf-8') as f:
    content = f.read()

content = content.replace(
    '.timeline-new__heatmap-sticky {\n  position: sticky;\n  top: 0;\n  z-index: 6;\n  width: 100%;\n  background: var(--color-bg, var(--color-canvas));\n  padding: var(--space-3, 12px) 0;',
    '.timeline-new__heatmap-sticky {\n  position: sticky;\n  top: 0;\n  z-index: 6;\n  width: 100%;\n  background: var(--color-bg, var(--color-canvas));\n  padding: 6px 0;',
    1,
)
print('[OK] .timeline-new__heatmap-sticky padding: 12 → 6')

# ============================================================
# 2. TimelineNewView.vue：强化 git-graph-header sticky 视觉反馈
# ============================================================
# 当前 .git-graph-header 第一个独立块：
#   top: var(--heatmap-sticky-height, 0px);
#   z-index: 5;
# 改成：保留 top，加 shadow + z-index 升级避免被 commit rows 遮挡
content = content.replace(
    '.git-graph-header {\n  top: var(--heatmap-sticky-height, 0px);\n  z-index: 5;\n}',
    '''.git-graph-header {
  top: var(--heatmap-sticky-height, 0px);
  z-index: 5;
  /* v0.7.4：sticky 视觉强化 —— shadow 让滚动时表头有"漂浮"反馈 */
  box-shadow: 0 1px 0 var(--color-divider), 0 2px 4px rgba(0, 0, 0, 0.08);
}''',
    1,
)
print('[OK] .git-graph-header 加 sticky shadow')

# 2.1 .timeline-new__topbar padding 紧凑化（可选）
content = content.replace(
    '.timeline-new__topbar {\n  display: flex;\n  align-items: center;\n  gap: var(--space-3, 12px);\n  padding: var(--space-3, 12px) var(--space-4, 16px);',
    '.timeline-new__topbar {\n  display: flex;\n  align-items: center;\n  gap: var(--space-3, 12px);\n  padding: var(--space-2, 8px) var(--space-4, 16px);',
    1,
)
print('[OK] .timeline-new__topbar padding 垂直: 12 → 8')

with open(PATH_VIEW, 'w', encoding='utf-8') as f:
    f.write(content)

# ============================================================
# 3. 写回组件
# ============================================================
with open(PATH_COMPONENT, 'w', encoding='utf-8') as f:
    f.write(content)

print('[OK] 紧凑化 + sticky 强化 全部完成')
