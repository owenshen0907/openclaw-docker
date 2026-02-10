#!/bin/bash
# ============================================================
# OpenClaw 统一管理脚本 (一键启停 + 常用操作)
#
# 用法:
#   ./oc.sh start     启动 OpenClaw
#   ./oc.sh stop      停止 OpenClaw
#   ./oc.sh restart   重启 OpenClaw
#   ./oc.sh status    查看运行状态
#   ./oc.sh logs      查看实时日志
#   ./oc.sh update    更新到最新版本
#   ./oc.sh doctor    运行诊断检查
#   ./oc.sh pair <platform> <code>   配对聊天平台
#   ./oc.sh channel add <platform> --token <token>  添加频道
#   ./oc.sh shell     进入容器 Shell
#   ./oc.sh backup    备份配置数据
#   ./oc.sh help      显示帮助
# ============================================================

set -e
cd "$(dirname "$0")"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

# 检测 compose 命令
if docker compose version &> /dev/null 2>&1; then
    COMPOSE="docker compose"
else
    COMPOSE="docker-compose"
fi

case "${1:-help}" in

  # ---- 启动 ----
  start)
    echo -e "${GREEN}▶ 启动 OpenClaw...${NC}"
    $COMPOSE up -d openclaw-gateway
    sleep 2
    $COMPOSE ps
    echo ""
    echo -e "${GREEN}✓ 已启动${NC}  →  http://127.0.0.1:18789/"
    ;;

  # ---- 停止 ----
  stop)
    echo -e "${YELLOW}■ 停止 OpenClaw...${NC}"
    $COMPOSE down
    echo -e "${YELLOW}✓ 已停止${NC}"
    ;;

  # ---- 重启 ----
  restart)
    echo -e "${CYAN}↻ 重启 OpenClaw...${NC}"
    $COMPOSE restart openclaw-gateway
    sleep 2
    $COMPOSE ps
    echo -e "${GREEN}✓ 已重启${NC}"
    ;;

  # ---- 状态 ----
  status)
    echo -e "${CYAN}ℹ OpenClaw 运行状态:${NC}"
    echo ""
    $COMPOSE ps
    echo ""
    # 健康检查
    if curl -sf http://127.0.0.1:18789/health > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Gateway 健康检查通过${NC}"
    else
        echo -e "${RED}✗ Gateway 无响应 (可能正在启动中)${NC}"
    fi
    # 数据目录大小
    echo ""
    echo "数据目录大小:"
    du -sh ./data/openclaw-config 2>/dev/null || echo "  配置目录不存在"
    du -sh ./data/workspace 2>/dev/null || echo "  工作区不存在"
    ;;

  # ---- 日志 ----
  logs)
    echo -e "${CYAN}📋 实时日志 (Ctrl+C 退出):${NC}"
    $COMPOSE logs -f openclaw-gateway
    ;;

  # ---- 更新 ----
  update)
    echo -e "${CYAN}⬆ 更新 OpenClaw...${NC}"
    echo "1. 拉取最新镜像..."
    $COMPOSE pull openclaw-gateway
    echo "2. 重建容器..."
    $COMPOSE up -d openclaw-gateway
    sleep 2
    $COMPOSE ps
    echo -e "${GREEN}✓ 更新完成${NC}"
    ;;

  # ---- 诊断 ----
  doctor)
    echo -e "${CYAN}🔍 运行诊断检查...${NC}"
    $COMPOSE run --rm openclaw-cli doctor
    ;;

  # ---- 配对 ----
  pair)
    if [ -z "$2" ] || [ -z "$3" ]; then
        echo "用法: ./oc.sh pair <platform> <code>"
        echo "示例: ./oc.sh pair telegram ABC123"
        exit 1
    fi
    echo -e "${CYAN}🔗 配对 $2...${NC}"
    $COMPOSE run --rm openclaw-cli pairing approve "$2" "$3"
    echo -e "${GREEN}✓ 配对完成${NC}"
    ;;

  # ---- 添加频道 ----
  channel)
    shift
    if [ "${1}" = "add" ]; then
        shift
        echo -e "${CYAN}📡 添加频道...${NC}"
        $COMPOSE run --rm openclaw-cli channels add "$@"
        echo ""
        echo -e "${YELLOW}⚠ 需要重启以生效:${NC}  ./oc.sh restart"
    else
        echo "用法: ./oc.sh channel add --channel <platform> --token <token>"
        echo ""
        echo "示例:"
        echo "  ./oc.sh channel add --channel telegram --token \"BOT_TOKEN\""
        echo "  ./oc.sh channel add --channel slack --token \"xoxb-xxx\" --app-token \"xapp-xxx\""
        echo "  ./oc.sh channel add --channel discord --token \"DISCORD_TOKEN\""
    fi
    ;;

  # ---- Shell ----
  shell)
    echo -e "${CYAN}🐚 进入容器 Shell...${NC}"
    $COMPOSE exec openclaw-gateway /bin/bash || \
    $COMPOSE exec openclaw-gateway /bin/sh
    ;;

  # ---- 备份 ----
  backup)
    BACKUP_FILE="openclaw-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    echo -e "${CYAN}💾 备份数据到 ${BACKUP_FILE}...${NC}"
    tar -czf "$BACKUP_FILE" ./data/
    echo -e "${GREEN}✓ 备份完成: $(du -h "$BACKUP_FILE" | cut -f1)${NC}"
    ;;

  # ---- 帮助 ----
  help|*)
    echo ""
    echo -e "${CYAN}OpenClaw Docker 管理工具${NC}"
    echo ""
    echo "用法: ./oc.sh <命令>"
    echo ""
    echo "常用命令:"
    echo "  start              启动 OpenClaw"
    echo "  stop               停止 OpenClaw"
    echo "  restart            重启 OpenClaw"
    echo "  status             查看运行状态"
    echo "  logs               查看实时日志"
    echo ""
    echo "维护命令:"
    echo "  update             更新到最新版本"
    echo "  doctor             运行诊断检查"
    echo "  backup             备份配置数据"
    echo "  shell              进入容器 Shell"
    echo ""
    echo "频道管理:"
    echo "  pair <平台> <码>    配对聊天平台"
    echo "  channel add ...    添加新频道"
    echo ""
    echo "示例:"
    echo "  ./oc.sh start"
    echo "  ./oc.sh pair telegram ABC123"
    echo "  ./oc.sh channel add --channel discord --token \"TOKEN\""
    echo ""
    ;;
esac
