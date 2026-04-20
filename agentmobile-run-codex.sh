#!/bin/bash
# agentmobile-run-codex.sh — 以指定配置 profile 启动 codex
# 用法: agentmobile-run-codex.sh <profile_id> <project_absolute_path>

set -e

PROFILE="$1"
PROJECT="$2"

if [ -z "$PROJECT" ]; then
    echo "[agentmobile] Usage: agentmobile-run-codex.sh <profile> <project_path>"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/agentmobile-run-common.sh"
agentmobile_build_path
agentmobile_bootstrap_shell_env "$0" "$PROFILE" "$PROJECT"
agentmobile_build_path

if [ -z "$PROFILE" ]; then
    PROFILE="$AGENTMOBILE_NO_PROFILE"
fi

if agentmobile_has_profile "$PROFILE"; then
    CONFIG_FILE="${SCRIPT_DIR}/data/configs/${PROFILE}.json"
    if [ ! -f "$CONFIG_FILE" ]; then
        echo "[agentmobile] Config profile '${PROFILE}' not found at ${CONFIG_FILE}"
        exit 1
    fi
fi

# 用 python3 读取 JSON 配置
cfg() {
    if ! agentmobile_has_profile "$PROFILE"; then
        printf '%s\n' ""
        return
    fi
    python3 -c "import json; d=json.load(open('${CONFIG_FILE}')); print(d.get('$1',''))"
}

BASE_URL=$(cfg BASE_URL)
API_KEY=$(cfg API_KEY)
DEFAULT_MODEL=$(cfg DEFAULT_MODEL)
REASONING_EFFORT=$(cfg REASONING_EFFORT)
SANDBOX_MODE=$(cfg SANDBOX_MODE)
LABEL=$(cfg label)
BASE_URL="${BASE_URL:-${OPENAI_BASE_URL:-}}"
API_KEY="${API_KEY:-${OPENAI_API_KEY:-}}"
DEFAULT_MODEL="${DEFAULT_MODEL:-${CODEX_MODEL:-}}"
PROFILE_DISPLAY="${LABEL:-$PROFILE}"
if ! agentmobile_has_profile "$PROFILE"; then
    PROFILE_DISPLAY="default (shell env)"
fi

# ── 导出所有环境变量 ──
export LANG="C.UTF-8"
export LC_ALL="C.UTF-8"

if agentmobile_has_profile "$PROFILE"; then
    unset OPENAI_BASE_URL OPENAI_API_KEY CODEX_MODEL
fi

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

CODEX_BIN="$(agentmobile_resolve_binary codex)" || agentmobile_cli_error_and_shell "Codex" "codex"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  agentmobile · Codex Session"
echo "║  Profile : ${PROFILE_DISPLAY}"
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
    "$CODEX_BIN" --yolo || true
    agentmobile_exit_menu "Codex"
done
