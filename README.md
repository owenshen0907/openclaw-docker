# OpenClaw Docker Admin

这是一个 **管理 OpenClaw Docker 容器** 的项目。  
定位是：管理、配置、引导，不把整套管理端再封装进容器。

当前模式：

- OpenClaw 运行在 Docker（`openclaw-gateway`）
- 管理面板运行在本机进程（Node.js）

---

## 先回答你现在的问题

### 需要先删容器和镜像吗？

**不需要先删。**

- 正常迁移时，保留 `openclaw-gateway` 和镜像即可
- 只需要移除旧版 `openclaw-admin` 管理容器（如果你之前用过）

本项目的 `./install.sh` 已经会自动清理旧 `openclaw-admin` 容器。

如果你想手动清理：

```bash
docker rm -f openclaw-admin 2>/dev/null || true
# 镜像不是必须删，可选清理：
docker image prune -f
```

---

## 项目适合谁

- 想在工作电脑上稳定运行 OpenClaw
- 希望控制环境污染和权限边界
- 需要图形化管理（安装、启停、日志、频道配置、排障）

---

## Docker 版好处（工作机友好）

| 维度 | 价值 |
|---|---|
| 环境隔离 | 不污染系统依赖，冲突更少 |
| 可迁移 | 数据都在 `./data`，可直接备份迁移 |
| 可回滚 | 切换镜像 tag 后可快速重建 |
| 运维效率 | 启停、更新、日志都可脚本化 |
| 安全性 | 默认绑定 `127.0.0.1`，不直接暴露公网 |

---

## 工作机 Docker + 个人机直装（推荐组合）

- 工作机：本项目（稳定、可控）
- 个人机：直装版（完整能力、深度操控）
- API Key / Token 分开管理，降低风险

---

## 快速开始

### 0) 前置要求

- Docker + Docker Compose
- Node.js 20+
- 至少一个模型 API Key（OpenAI / Anthropic / Gemini）

### 1) 准备配置

```bash
cp .env.example .env
```

编辑 `.env`（至少填一个 Key）：

```bash
OPENAI_API_KEY=your_key
# 或 ANTHROPIC_API_KEY / GEMINI_API_KEY

OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
ADMIN_PORT=3000
```

### 2) 启动管理面板（本地进程）

```bash
chmod +x install.sh oc.sh
./install.sh start
```

访问：

- Admin UI: `http://127.0.0.1:3000/`
- 场景手册: `http://127.0.0.1:3000/scenarios.html`

如果你改过 `ADMIN_PORT`，把 `3000` 替换成对应端口。

### 3) 在面板里点击「首次安装」

安装完成后，建议执行：

- 「状态检查」
- 「实时日志」
- 用「带 token」链接进入 OpenClaw 控制台

---

## 管理面板命令

```bash
./install.sh start
./install.sh stop
./install.sh restart
./install.sh status
./install.sh uninstall
```

日志文件：`./.openclaw-admin.log`

---

## 卸载

默认安全卸载（推荐）：移除管理面板进程 + OpenClaw 容器，**保留 `./data`**。

```bash
./install.sh uninstall
```

连数据一起删除：

```bash
./install.sh uninstall --with-data
```

彻底卸载（删除容器 + 数据 + 镜像 + web 本地依赖缓存）：

```bash
./install.sh uninstall --all
```

---

## OpenClaw 常用命令

```bash
./oc.sh start
./oc.sh stop
./oc.sh restart
./oc.sh status
./oc.sh logs
./oc.sh update
./oc.sh doctor
./oc.sh backup
```

频道示例：

```bash
./oc.sh channel add --channel telegram --token "$TELEGRAM_BOT_TOKEN"
./oc.sh channel add --channel discord --token "$DISCORD_BOT_TOKEN"
./oc.sh channel add --channel slack --token "$SLACK_BOT_TOKEN" --app-token "$SLACK_APP_TOKEN"
```

---

## 常见问题

### `unauthorized: gateway token missing`

请使用带 token 的地址进入：

```text
http://127.0.0.1:<OPENCLAW_GATEWAY_PORT>/#token=<OPENCLAW_GATEWAY_TOKEN>
```

### `disconnected (1008): pairing required`

在管理面板点「修复配对」，然后刷新控制台。

### `bind: address already in use`

先查端口占用：

```bash
lsof -nP -iTCP:18789 -sTCP:LISTEN
```

再停止冲突进程或改 `.env` 里的端口。

---

## 数据与安全

- 运行数据在 `./data/`
- `.env` 已在 `.gitignore` 中忽略，不要提交密钥
- 服务默认监听本地回环地址

---

## 项目结构

```text
openclaw-docker/
├── .env.example          # 环境变量模板
├── docker-compose.yml    # 仅 OpenClaw 容器（gateway + cli）
├── install.sh            # 本地管理面板启动脚本
├── oc.sh                 # OpenClaw 日常管理脚本
├── web/                  # 管理面板与静态场景页
└── data/                 # 持久化数据
```
