#!/bin/bash
# ============================================================
# OpenClaw 管理面板启动脚本（本地模式）
# 用途: 本地运行 Web 管理面板，管理 OpenClaw Docker 容器
# 命令: start | stop | restart | status | uninstall
# ============================================================

set -euo pipefail
cd "$(dirname "$0")"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn()  { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; }

PID_FILE=".openclaw-admin.pid"
LOG_FILE=".openclaw-admin.log"
WEB_DIR="$(pwd)/web"
ACTION="${1:-start}"
UNINSTALL_OPTION="${2:-}"

is_process_running() {
  local pid="$1"
  kill -0 "$pid" >/dev/null 2>&1
}

read_env_value() {
  local key="$1"
  local default="$2"
  local value=""
  if [ -f ".env" ]; then
    value="$(grep -E "^${key}=" .env | head -n1 | cut -d= -f2- || true)"
  fi
  if [ -n "$value" ]; then
    echo "$value"
  else
    echo "$default"
  fi
}

print_access_info() {
  local port="$1"
  echo ""
  echo "=========================================="
  echo -e "  ${GREEN}管理面板已启动${NC}"
  echo "=========================================="
  echo ""
  echo "  Admin UI:  http://127.0.0.1:${port}/"
  echo "  场景手册:  http://127.0.0.1:${port}/scenarios.html"
  echo "  日志文件:  ${LOG_FILE}"
  echo ""
  echo "  下一步:"
  echo "    1. 打开 Admin UI"
  echo "    2. 点击「首次安装」完成 OpenClaw 初始化"
  echo "    3. 后续启停、更新、日志和频道管理都在该页面完成"
  echo ""
}

echo ""
echo "=========================================="
echo "  OpenClaw Admin 启动向导（本地模式）"
echo "=========================================="
echo ""

if ! command -v docker >/dev/null 2>&1; then
  error "未找到 Docker，请先安装: https://docs.docker.com/get-docker/"
  exit 1
fi
info "Docker: $(docker --version)"

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
  info "Docker Compose: $(docker compose version)"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
  info "Docker Compose: $(docker-compose --version)"
else
  error "未找到 Docker Compose，请先安装"
  exit 1
fi

if [ "$ACTION" != "uninstall" ] && [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    error "未找到 .env，已自动生成模板文件 .env，请先填写至少一个 API Key 后重试"
    exit 1
  fi
  error "未找到 .env 文件，请先配置"
  exit 1
fi

ADMIN_PORT="$(read_env_value ADMIN_PORT 3000)"
OPENCLAW_IMAGE="$(read_env_value OPENCLAW_IMAGE alpine/openclaw)"

remove_legacy_admin_container() {
  if docker ps -a --format '{{.Names}}' | grep -qx 'openclaw-admin'; then
    warn "检测到旧版 openclaw-admin 容器，正在移除（迁移到本地管理模式）..."
    docker rm -f openclaw-admin >/dev/null 2>&1 || true
    info "旧版 openclaw-admin 容器已移除"
  fi
}

start_admin() {
  remove_legacy_admin_container

  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && is_process_running "$pid"; then
      info "管理面板已在运行 (PID: ${pid})"
      print_access_info "$ADMIN_PORT"
      exit 0
    fi
    rm -f "$PID_FILE"
  fi

  if lsof -nP -iTCP:"${ADMIN_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    error "端口 ${ADMIN_PORT} 已被占用，请先释放端口或修改 .env 的 ADMIN_PORT"
    lsof -nP -iTCP:"${ADMIN_PORT}" -sTCP:LISTEN || true
    exit 1
  fi

  if ! command -v node >/dev/null 2>&1; then
    error "未找到 Node.js，请先安装 Node.js 20+"
    exit 1
  fi
  if ! command -v npm >/dev/null 2>&1; then
    error "未找到 npm，请先安装 npm"
    exit 1
  fi
  info "Node: $(node --version)"
  info "npm: $(npm --version)"

  if [ ! -d "$WEB_DIR/node_modules" ]; then
    info "安装 Web 依赖..."
    npm --prefix "$WEB_DIR" install
  fi

  info "构建前端资源..."
  npm --prefix "$WEB_DIR" run build

  info "启动本地管理面板..."
  ADMIN_PORT="$ADMIN_PORT" nohup node "$WEB_DIR/server.js" > "$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  sleep 1
  if ! is_process_running "$pid"; then
    error "管理面板启动失败，请查看日志: ${LOG_FILE}"
    tail -n 40 "$LOG_FILE" || true
    exit 1
  fi

  print_access_info "$ADMIN_PORT"
}

stop_admin() {
  local stopped=0

  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && is_process_running "$pid"; then
      kill "$pid" >/dev/null 2>&1 || true
      sleep 1
      if is_process_running "$pid"; then
        kill -9 "$pid" >/dev/null 2>&1 || true
      fi
      info "本地管理面板已停止 (PID: ${pid})"
      stopped=1
    fi
    rm -f "$PID_FILE"
  fi

  if docker ps -a --format '{{.Names}}' | grep -qx 'openclaw-admin'; then
    warn "检测到旧版 openclaw-admin 容器，正在移除..."
    docker rm -f openclaw-admin >/dev/null 2>&1 || true
    info "旧版 openclaw-admin 容器已移除"
    stopped=1
  fi

  if [ "$stopped" -eq 0 ]; then
    info "管理面板未在运行"
  fi
}

status_admin() {
  local running='no'
  if [ -f "$PID_FILE" ]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && is_process_running "$pid"; then
      running="yes (PID: ${pid})"
    fi
  fi

  echo "管理面板状态: ${running}"
  echo "管理面板端口: ${ADMIN_PORT}"

  if docker ps -a --format '{{.Names}}' | grep -qx 'openclaw-admin'; then
    warn "检测到旧版 openclaw-admin 容器（可执行 ./install.sh start 自动迁移）"
  fi

  if lsof -nP -iTCP:"${ADMIN_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "端口监听: yes"
  else
    echo "端口监听: no"
  fi

  echo ""
  echo "OpenClaw 容器状态:"
  $COMPOSE_CMD ps
}

uninstall_all() {
  local remove_data=0
  local remove_image=0

  case "$UNINSTALL_OPTION" in
    ""|--keep-data)
      ;;
    --with-data)
      remove_data=1
      ;;
    --all)
      remove_data=1
      remove_image=1
      ;;
    *)
      error "用法: ./install.sh uninstall [--keep-data|--with-data|--all]"
      exit 1
      ;;
  esac

  echo ""
  echo "=========================================="
  echo "  OpenClaw 卸载向导"
  echo "=========================================="
  echo ""

  stop_admin

  info "停止并移除 OpenClaw 容器..."
  $COMPOSE_CMD down --remove-orphans >/dev/null 2>&1 || true
  docker rm -f openclaw-gateway openclaw-cli >/dev/null 2>&1 || true

  if [ "$remove_data" -eq 1 ]; then
    warn "删除本地数据目录: ./data/"
    rm -rf ./data
    info "数据目录已删除"
  else
    info "保留数据目录: ./data/ (可用于后续恢复)"
  fi

  if [ "$remove_image" -eq 1 ]; then
    warn "删除镜像: ${OPENCLAW_IMAGE}"
    docker image rm -f "${OPENCLAW_IMAGE}" >/dev/null 2>&1 || true
    info "镜像已尝试删除（若被其它容器占用会自动跳过）"

    warn "清理管理面板本地构建缓存: web/dist web/node_modules"
    rm -rf ./web/dist ./web/node_modules
  else
    info "保留镜像与本地依赖缓存（下次启动更快）"
  fi

  rm -f "$PID_FILE" "$LOG_FILE"

  echo ""
  echo "=========================================="
  echo -e "  ${GREEN}卸载完成${NC}"
  echo "=========================================="
  echo ""
  echo "  已移除: 管理面板进程 + OpenClaw 容器"
  if [ "$remove_data" -eq 1 ]; then
    echo "  已移除: ./data/"
  else
    echo "  已保留: ./data/"
  fi
  if [ "$remove_image" -eq 1 ]; then
    echo "  已移除: ${OPENCLAW_IMAGE} (如可删除)"
  else
    echo "  已保留: ${OPENCLAW_IMAGE}"
  fi
  echo ""
}

case "$ACTION" in
  start)
    start_admin
    ;;
  stop)
    stop_admin
    ;;
  restart)
    stop_admin
    start_admin
    ;;
  status)
    status_admin
    ;;
  uninstall)
    uninstall_all
    ;;
  *)
    echo "用法: ./install.sh [start|stop|restart|status|uninstall]"
    echo "卸载: ./install.sh uninstall [--keep-data|--with-data|--all]"
    exit 1
    ;;
esac
