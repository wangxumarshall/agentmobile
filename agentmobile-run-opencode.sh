#!/bin/bash
# agentmobile-run-opencode.sh — 以指定配置 profile 启动 OpenCode
# 用法: agentmobile-run-opencode.sh <profile_id> <project_absolute_path>

set -e

PROFILE="$1"
PROJECT="$2"

if [ -z "$PROJECT" ]; then
    echo "[agentmobile] Usage: agentmobile-run-opencode.sh <profile> <project_path>"
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

cfg() {
    if ! agentmobile_has_profile "$PROFILE"; then
        printf '%s\n' ""
        return
    fi
    python3 -c "import json; d=json.load(open('${CONFIG_FILE}')); print(d.get('$1',''))"
}

BASE_URL=$(cfg BASE_URL)
API_KEY=$(cfg API_KEY)
AUTH_TOKEN=$(cfg AUTH_TOKEN)
DEFAULT_MODEL=$(cfg DEFAULT_MODEL)
LABEL=$(cfg label)
BASE_URL="${BASE_URL:-${OPENAI_BASE_URL:-}}"
API_KEY="${API_KEY:-${OPENAI_API_KEY:-}}"
AUTH_TOKEN="${AUTH_TOKEN:-${OPENAI_API_KEY:-}}"
DEFAULT_MODEL="${DEFAULT_MODEL:-${OPENCODE_MODEL:-}}"
PROFILE_DISPLAY="${LABEL:-$PROFILE}"
if ! agentmobile_has_profile "$PROFILE"; then
    PROFILE_DISPLAY="default (shell env)"
fi

export LANG="C.UTF-8"
export LC_ALL="C.UTF-8"

if agentmobile_has_profile "$PROFILE"; then
    unset OPENAI_BASE_URL OPENAI_API_KEY OPENCODE_MODEL
fi

if [ -n "$BASE_URL" ]; then
    export OPENAI_BASE_URL="$BASE_URL"
fi
if [ -n "$API_KEY" ]; then
    export OPENAI_API_KEY="$API_KEY"
elif [ -n "$AUTH_TOKEN" ]; then
    export OPENAI_API_KEY="$AUTH_TOKEN"
fi
if [ -n "$DEFAULT_MODEL" ]; then
    export OPENCODE_MODEL="$DEFAULT_MODEL"
fi

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

OPENCODE_BIN="$(agentmobile_resolve_binary opencode)" || agentmobile_cli_error_and_shell "OpenCode" "opencode"

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  agentmobile · OpenCode Session"
echo "║  Profile : ${PROFILE_DISPLAY}"
echo "║  Project : $PROJECT"
echo "╚══════════════════════════════════════════╝"
echo ""

while true; do
    "$OPENCODE_BIN" "$PROJECT" || true
    agentmobile_exit_menu "OpenCode"
done
