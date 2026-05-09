#!/usr/bin/env bash
set -euo pipefail

read_env_value() {
  local key="$1"
  local line
  if [ ! -f .env ]; then
    return 0
  fi
  line="$(grep -E "^[[:space:]]*${key}=" .env | tail -n 1 || true)"
  if [ -z "$line" ]; then
    return 0
  fi
  line="${line#*=}"
  line="${line%$'\r'}"
  printf '%s' "$line"
}

session="${TMUX_SESSION:-}"
workspace="${WORKSPACE_ROOT:-}"
if [ -z "$session" ]; then
  session="$(read_env_value TMUX_SESSION)"
fi
if [ -z "$workspace" ]; then
  workspace="$(read_env_value WORKSPACE_ROOT)"
fi
session="${session:-main}"
workspace="${workspace:-$HOME}"
shell_cmd="${SHELL:-/bin/bash}"
window_name="$(basename "$workspace")"
history_limit="${TMUX_HISTORY_LIMIT:-}"
if [ -z "$history_limit" ]; then
  history_limit="$(read_env_value TMUX_HISTORY_LIMIT)"
fi
history_limit="${history_limit:-50000}"

if ! command -v tmux >/dev/null 2>&1; then
  echo "[agentmobile-tmux] tmux command not found" >&2
  exit 127
fi

ensure_session() {
  tmux set-option -g history-limit "$history_limit" >/dev/null
  if ! tmux has-session -t "$session" 2>/dev/null; then
    tmux new-session -d -s "$session" -n "$window_name" -c "$workspace" "$shell_cmd"
  fi
  tmux set-option -t "$session" history-limit "$history_limit" >/dev/null
}

ensure_session
echo "[agentmobile-tmux] tmux runtime ready: $session"

while true; do
  ensure_session
  tmux wait-for "agentmobile-tmux-runtime-$session" || true
  sleep 5
done
