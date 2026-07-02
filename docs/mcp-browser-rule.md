# MCP 浏览器进程管理规则（待添加到全局配置）

> 本文件是规则参考，请将以下内容添加到 `~/AGENTS.md` 和 `~/CLAUDE.md` 中。

---

## MCP 浏览器进程管理规则

**核心规则：MCP 拉起的 Chrome 浏览器进程，使用完毕后必须立即关闭，不能浪费系统资源。**

### 识别 MCP 拉起的浏览器进程

MCP 拉起的 Chrome 进程特征：
- `--user-data-dir` 包含 `playwright_chromiumdev_profile` 临时目录
- 包含 `--remote-debugging-pipe` 参数
- 由 `playwright-mcp` / `chrome-devtools-mcp` 进程启动

```bash
# 识别命令
ps aux | grep "playwright_chromiumdev_profile" | grep -v grep | awk '{print $2}'
```

### 关闭时机
- 完成调试/截图/页面分析后立即关闭
- 对话结束时检查并关闭
- 发现空闲的 MCP 浏览器进程时主动关闭

### 关闭方法

**页面级别（优先）：**
```javascript
mcp__chrome-devtools__close_page(pageId)
```

**进程级别（备用）：**
```bash
kill -9 $(ps aux | grep "playwright_chromiumdev_profile" | grep -v grep | awk '{print $2}')
```

### 保护规则

**禁止关闭用户自己启动的浏览器：**
- 无 `playwright_chromiumdev_profile` 的 Chrome 进程是用户的
- 禁止 `pkill -f Chrome` 这样会误杀所有 Chrome 进程
- 如果不确定进程归属，**不要关闭**

**禁止关闭其他开发工具：**
- VS Code 渲染进程
- 其他 IDE 或编辑器进程
- 系统服务进程

### 最佳实践

- **任务收尾检查**：每次任务结束前，检查是否有 MCP 浏览器进程残留
- **最小化使用**：如果不需要浏览器功能，尽量不拉起 MCP 浏览器
- **及时释放**：使用完毕后立即关闭，不要等待
- **记录日志**：关闭时记录关闭了哪些进程，便于追踪

### 常见错误

**错误做法：**
```bash
# ❌ 会误杀所有 Chrome 进程
pkill -f Chrome
```

**正确做法：**
```bash
# ✅ 精确识别并关闭 MCP 进程
ps aux | grep "playwright_chromiumdev_profile" | grep -v grep | awk '{print $2}' | xargs kill -9

# ✅ 关闭后验证
ps aux | grep "playwright_chromiumdev_profile" | grep -v grep | wc -l
```

**Why:** MCP 浏览器进程会持续占用 CPU、内存和网络资源，特别是 Chromium 进程数量多、内存占用大。及时关闭可以释放系统资源，避免影响用户其他工作。

**How to apply:**
- 每次使用 MCP 浏览器工具后，任务收尾时主动关闭
- 定期检查系统进程，发现 MCP 浏览器残留立即清理
- 在代码中避免不必要的浏览器操作，优先使用其他工具

---

## 手动添加步骤

### 1. 添加到 ~/AGENTS.md

```bash
cat >> ~/AGENTS.md << 'EOF'

## MCP 浏览器进程管理规则

[将上面的规则内容粘贴到这里]

EOF
```

### 2. 添加到 ~/CLAUDE.md

```bash
cat >> ~/CLAUDE.md << 'EOF'

## MCP 浏览器进程管理规则

[将上面的规则内容粘贴到这里]

EOF
```

### 3. 验证添加成功

```bash
grep -n "MCP 浏览器进程管理" ~/AGENTS.md ~/CLAUDE.md
```
