#!/bin/bash
# nexus-run-codex.sh — 以指定配置 profile 启动 codex
# 用法: nexus-run-codex.sh <profile_id> <project_absolute_path>

set -e

PROFILE="$1"
PROJECT="$2"

if [ -z "$PROFILE" ] || [ -z "$PROJECT" ]; then
    echo "[Nexus] Usage: nexus-run-codex.sh <profile> <project_path>"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR}/data/configs/${PROFILE}.json"
if [ ! -f "$CONFIG_FILE" ]; then
    echo "[Nexus] Config profile '${PROFILE}' not found at ${CONFIG_FILE}"
    exit 1
fi

# 用 python3 读取 JSON 配置
cfg() {
    python3 -c "import json; d=json.load(open('${CONFIG_FILE}')); print(d.get('$1',''))"
}

BASE_URL=$(cfg BASE_URL)
API_KEY=$(cfg API_KEY)
DEFAULT_MODEL=$(cfg DEFAULT_MODEL)
REASONING_EFFORT=$(cfg REASONING_EFFORT)
SANDBOX_MODE=$(cfg SANDBOX_MODE)
LABEL=$(cfg label)

# ── 导出所有环境变量 ──
export LANG="C.UTF-8"
export LC_ALL="C.UTF-8"

if [ -n "$BASE_URL" ]; then
    export OPENAI_BASE_URL="$BASE_URL"
fi
if [ -n "$API_KEY" ]; then
    export OPENAI_API_KEY="$API_KEY"
fi
if [ -n "$DEFAULT_MODEL" ]; then
    export CODEX_MODEL="$DEFAULT_MODEL"
fi

# ── 代理变量：优先使用 NEXUS_PROXY（server.js 注入），其次继承环境 ──
_proxy="${NEXUS_PROXY:-${HTTP_PROXY:-}}"
if [ -n "$_proxy" ]; then
    export HTTP_PROXY="$_proxy"
    export HTTPS_PROXY="$_proxy"
    export ALL_PROXY="$_proxy"
    export http_proxy="$_proxy"
    export https_proxy="$_proxy"
fi
unset _proxy

cd "$PROJECT"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Nexus · Codex Session"
echo "║  Profile : ${LABEL:-$PROFILE}"
echo "║  Project : $PROJECT"
if [ -z "$BASE_URL" ]; then
    echo "║  API     : OpenAI (官方)"
elif [[ "$BASE_URL" == *"openrouter"* ]]; then
    echo "║  API     : OpenRouter"
else
    echo "║  API     : 自定义"
fi
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 主循环：退出后提示续接 ──
while true; do
    # 启动 codex 交互式 TUI
    codex --yolo || true
    echo ""
    echo "[Nexus] Codex exited.  r=restart  b=bash shell  q=quit window"
    read -r REPLY
    case "$REPLY" in
        b) exec bash -i ;;
        q) break ;;
    esac
done

echo "[Nexus] Session ended."
# 退出后启动 bash 保持窗口打开（防止用户意外关闭窗口）
exec bash -i
