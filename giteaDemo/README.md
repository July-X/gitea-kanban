# gitea 本地测试服务

> ⚠️ **这是测试服务**，**不会**自动启动。开发 gitea-kanban 需要 gitea 时手动 `up`，用完 `down`。
> 详见本文档"使用流程"。

## 这是什么

给 `gitea-kanban` 桌面应用开发用的本地 gitea 实例，docker compose 部署，数据全部落本目录。

- 镜像：`docker.gitea.com/gitea:1.26.2`（钉版本，不用 `:latest`）
- 数据库：内置 SQLite3（不需要 mysql/postgres 容器）
- HTTP：`http://localhost:3000`
- SSH：主机 `2222` → 容器 `22`
- 数据：当前目录 `./data/`（git 排除）

## 目录结构

```
giteaDemo/
├── README.md             # 本文件
├── docker-compose.yml    # compose 配置
├── data/                 # gitea 所有运行时数据（git 排除）
│   ├── gitea/
│   │   ├── conf/app.ini
│   │   ├── repositories/
│   │   └── ...
│   └── ...
└── .gitignore            # 排除 data/ 等
```

## 首次启动

```bash
cd giteaDemo
docker compose up -d      # 后台启动
docker compose ps         # 看状态，看 healthcheck 是否 healthy
docker compose logs -f    # 实时日志
```

等 30 秒后浏览器打开 `http://localhost:3000`，会进 gitea 安装向导：

| 字段 | 填写 |
|------|------|
| 数据库类型 | SQLite3 |
| 一般设置 → 站点名称 | Gitea Kanban Test |
| 可选功能 | 启用开放注册 / 禁用都 OK |
| 管理员账户 | 自建一个（比如 `admin` / `admin123`，仅本地测试用） |
| 改完点"立即安装" | 30 秒左右出"已安装"页 |

**安装完成后 INSTALL_LOCK 会自动 true，禁止再走安装向导**。要重装就 `docker compose down -v` 把数据卷也清掉。

## 使用流程（开发看板时）

```bash
# 1. 启
cd giteaDemo && docker compose up -d

# 2. 在 gitea UI 里建几个测试仓库、几个 PR、几个分支
#    http://localhost:3000 → 登录 → 右上角 + → 新建仓库

# 3. 跑 gitea-kanban 桌面应用，连 http://localhost:3000 测 OAuth/PAT

# 4. 用完关（释放资源）
cd giteaDemo && docker compose down
```

> 💡 **不**需要 gitea 时**一定** `docker compose down`——这服务默认 `restart: "no"`，但容器只要在跑就占内存/磁盘。

## 常见操作

| 需求 | 命令 |
|------|------|
| 启动 | `docker compose up -d` |
| 停止（保留数据） | `docker compose down` |
| 完全重置（清数据） | `docker compose down -v` + `rm -rf data` |
| 看实时日志 | `docker compose logs -f` |
| 看资源占用 | `docker stats gitea-kanban-test` |
| 进容器调试 | `docker compose exec server bash` |

## 跟 gitea-kanban 的连接

桌面应用通过 gitea REST API 跟本服务通信。典型配置：

| 项 | 值 |
|----|----|
| gitea Base URL | `http://localhost:3000` |
| 认证方式 | Personal Access Token（不走 OAuth 跳转） |
| 申请 PAT 路径 | 登录 → 右上角头像 → 设置 → 应用 → 生成新令牌，勾上 `repository (全部)` + `user (全部)` |
| 第一次连 | 把 token 粘到 gitea-kanban 的"连接"页（明文存 keychain，详见 02-architecture.md §2.6） |

## 故障排查

**端口 3000 被占**：
```bash
lsof -i :3000
# 杀掉占用的进程，或改 docker-compose.yml 里的 "3000:3000" 为 "3001:3000"
```

**端口 2222 被占**（常见于本机装了别的 ssh 服务）：
同上，改成 "2223:22" 即可。

**容器起不来 / 健康检查不过**：
```bash
docker compose logs server  # 看具体错误
# 99% 是 data 目录权限问题，删了重来：
docker compose down -v && rm -rf data && docker compose up -d
```

**gitea 改配置后没生效**：
`data/gitea/conf/app.ini` 是最终配置，docker 环境变量在启动时同步进去。改完 app.ini 要 `docker compose restart`。

## 数据备份 / 还原

```bash
# 备份
tar czf gitea-data-$(date +%Y%m%d).tar.gz data/

# 还原
rm -rf data && tar xzf gitea-data-20260610.tar.gz
```
