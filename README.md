# OpenClaw Docker 一键部署

基于 Docker 的 OpenClaw 部署方案，数据持久化到本地，支持一键启停。

## 项目结构

```
openclaw-docker/
├── .env                  ← 环境变量 (API Key、Token、端口等)
├── .gitignore            ← 排除敏感信息和运行数据
├── docker-compose.yml    ← Docker 编排配置
├── install.sh            ← 首次安装脚本
├── oc.sh                 ← 日常管理脚本
└── data/                 ← 持久化数据 (容器删除不丢失)
    ├── openclaw-config/  ← 配置、记忆、会话历史
    └── workspace/        ← Agent 工作区文件
```

## 前置要求

- Docker + Docker Compose
- 至少 2GB 内存 (推荐 4GB)
- 10GB 可用磁盘空间
- 至少一个 AI 供应商的 API Key (OpenAI / Anthropic / Google)

## 快速开始

### 1. 配置 .env

编辑 `.env` 文件，填入你的 API Key 和聊天平台 Token：

```bash
# AI 供应商 (至少填一个)
OPENAI_API_KEY=sk-proj-你的Key
# ANTHROPIC_API_KEY=sk-ant-你的Key
# GEMINI_API_KEY=你的Key

# Telegram Bot
TELEGRAM_BOT_TOKEN=你的BotToken

# Slack Bot (可选)
# SLACK_BOT_TOKEN=xoxb-你的Token
# SLACK_APP_TOKEN=xapp-你的Token

# Discord Bot (可选)
# DISCORD_BOT_TOKEN=你的Token
```

### 2. 首次安装

```bash
chmod +x install.sh oc.sh
./install.sh
```

脚本会自动完成：检查 Docker 环境 → 创建数据目录 → 拉取镜像 → 配置 Telegram → 启动服务。

### 3. 配对 Telegram

安装完成后，在 Telegram 中找到你的 Bot 发一条消息。如果终端出现配对码，运行：

```bash
./oc.sh pair telegram <配对码>
```

### 4. 访问控制面板

浏览器打开 http://127.0.0.1:18789/

## 日常管理

所有操作通过 `oc.sh` 完成：

```bash
./oc.sh start       # 启动
./oc.sh stop        # 停止
./oc.sh restart     # 重启
./oc.sh status      # 查看运行状态 + 健康检查
./oc.sh logs        # 实时日志 (Ctrl+C 退出)
./oc.sh update      # 拉取最新镜像并重建容器
./oc.sh doctor      # 运行诊断检查
./oc.sh backup      # 备份 data/ 目录为 tar.gz
./oc.sh shell       # 进入容器 Shell
```

## 频道管理

### 添加 Telegram

```bash
./oc.sh channel add --channel telegram --token "你的BOT_TOKEN"
./oc.sh restart
```

### 添加 Slack

需要两个 Token，在 https://api.slack.com/apps 创建 App 后获取：

```bash
./oc.sh channel add --channel slack --token "xoxb-xxx" --app-token "xapp-xxx"
./oc.sh restart
```

### 添加 Discord

在 https://discord.com/developers/applications 创建 Application 后获取 Bot Token：

```bash
./oc.sh channel add --channel discord --token "你的DISCORD_TOKEN"
./oc.sh restart
```

## 切换 AI 供应商

编辑 `.env` 文件，注释掉当前的 Key，填入新的即可：

```bash
# OPENAI_API_KEY=sk-proj-旧Key
ANTHROPIC_API_KEY=sk-ant-新Key
```

然后重启：

```bash
./oc.sh restart
```

也可以通过 Control UI (http://127.0.0.1:18789/) 在线修改。

## 数据与备份

所有数据存储在 `./data/` 目录下，包括：

- `openclaw-config/` — 配置文件、SQLite 记忆数据库、API Key
- `workspace/` — Agent 创建和使用的文件

一键备份：

```bash
./oc.sh backup
# 生成: openclaw-backup-20260211-143000.tar.gz
```

恢复备份：

```bash
tar -xzf openclaw-backup-20260211-143000.tar.gz
./oc.sh start
```

## 安全提醒

- `.env` 包含 API Key 和 Token，已在 `.gitignore` 中排除，请勿手动提交
- Gateway 端口仅绑定到 `127.0.0.1`，不会暴露到公网
- 如需远程访问，请使用 SSH 隧道而非开放端口
- 定期运行 `./oc.sh doctor` 检查配置安全性
