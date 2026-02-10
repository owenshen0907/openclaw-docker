#!/bin/bash
# ============================================================
# OpenClaw 首次安装脚本
# 用途: 检查环境 → 初始化目录 → 拉取镜像 → 配置 Telegram → 启动
# ============================================================

set -e
cd "$(dirname "$0")"
PROJECT_DIR="$(pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

echo ""
echo "=========================================="
echo "  OpenClaw Docker 首次安装"
echo "=========================================="
echo ""

# ---- 1. 检查 Docker ----
echo "--- 检查环境 ---"
if ! command -v docker &> /dev/null; then
    error "未找到 Docker，请先安装: https://docs.docker.com/get-docker/"
    exit 1
fi
info "Docker: $(docker --version)"

if docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
    info "Docker Compose: $(docker compose version)"
elif command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
    info "Docker Compose: $(docker-compose --version)"
else
    error "未找到 Docker Compose，请先安装"
    exit 1
fi

# ---- 2. 检查 .env ----
if [ ! -f ".env" ]; then
    error "未找到 .env 文件，请先配置"
    exit 1
fi
source .env

if [ -z "$OPENAI_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$GEMINI_API_KEY" ]; then
    error ".env 中未配置任何 AI 供应商的 API Key"
    exit 1
fi
info "API Key 已配置"

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    warn "未配置 Telegram Bot Token，跳过 Telegram 设置"
fi

# ---- 3. 创建数据目录 ----
echo ""
echo "--- 初始化数据目录 ---"
mkdir -p ./data/openclaw-config
mkdir -p ./data/workspace

# 写入 API Key 到 OpenClaw 的 env 文件
cat > ./data/openclaw-config/.env << EOF
OPENAI_API_KEY=${OPENAI_API_KEY}
EOF
chmod 600 ./data/openclaw-config/.env

# 设置目录权限 (Docker 内以 uid 1000 运行)
if [ "$(id -u)" = "0" ]; then
    chown -R 1000:1000 ./data
else
    sudo chown -R 1000:1000 ./data 2>/dev/null || true
fi
info "数据目录已创建: ./data/"

# ---- 4. 拉取镜像 ----
echo ""
echo "--- 拉取 Docker 镜像 ---"
$COMPOSE_CMD pull openclaw-gateway
info "镜像拉取完成"

# ---- 5. 首次启动 (使用 onboard 向导) ----
echo ""
echo "--- 首次启动 ---"
$COMPOSE_CMD up -d openclaw-gateway
info "Gateway 已启动"

# 等待服务就绪
echo -n "等待服务就绪..."
for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:18789/health > /dev/null 2>&1; then
        echo ""
        info "服务已就绪"
        break
    fi
    echo -n "."
    sleep 2
done
echo ""

# ---- 6. 配置 Telegram ----
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    echo ""
    echo "--- 配置 Telegram Bot ---"
    $COMPOSE_CMD run --rm openclaw-cli channels add \
        --channel telegram \
        --token "$TELEGRAM_BOT_TOKEN" 2>/dev/null || {
        warn "Telegram 自动配置失败，你可以稍后手动添加:"
        echo "  $COMPOSE_CMD run --rm openclaw-cli channels add --channel telegram --token \"$TELEGRAM_BOT_TOKEN\""
    }
    info "Telegram Bot 配置完成"

    # 重启以加载新频道
    $COMPOSE_CMD restart openclaw-gateway
    sleep 3
fi

# ---- 7. 完成 ----
echo ""
echo "=========================================="
echo -e "  ${GREEN}安装完成!${NC}"
echo "=========================================="
echo ""
echo "  Control UI:  http://127.0.0.1:18789/"
echo "  数据目录:    $PROJECT_DIR/data/"
echo "  配置文件:    $PROJECT_DIR/data/openclaw-config/"
echo "  工作区:      $PROJECT_DIR/data/workspace/"
echo ""
echo "  下一步:"
echo "    1. 在 Telegram 中找到你的 Bot 发送消息"
echo "    2. 如果出现配对码，运行:"
echo "       ./oc.sh pair telegram <配对码>"
echo "    3. 查看日志:  ./oc.sh logs"
echo ""
