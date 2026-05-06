#!/usr/bin/env bash
set -euo pipefail

unit="${1:-agentmobile-tmux.service}"
web_unit="${2:-agentmobile.service}"
target_cgroup="/sys/fs/cgroup/system.slice/${unit}"
web_cgroup="/system.slice/${web_unit}"
tmux_user="${SUDO_USER:-}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run as root: sudo $0 [tmux-unit] [web-unit]" >&2
  exit 1
fi

if [ ! -d /sys/fs/cgroup ]; then
  echo "cgroup filesystem not found" >&2
  exit 1
fi

systemctl start "$unit"
if [ -z "$tmux_user" ]; then
  tmux_user="$(systemctl show "$unit" -p User --value 2>/dev/null || true)"
fi
tmux_user="${tmux_user:-ubuntu}"

if [ ! -w "${target_cgroup}/cgroup.procs" ]; then
  echo "target cgroup is not writable: ${target_cgroup}/cgroup.procs" >&2
  exit 1
fi

collect_descendants() {
  local root="$1"
  local children
  printf '%s\n' "$root"
  children="$(pgrep -P "$root" 2>/dev/null || true)"
  for child in $children; do
    collect_descendants "$child"
  done
}

collect_tmux_pids() {
  local pids=()
  local server_pid
  server_pid="$(sudo -u "$tmux_user" tmux display-message -p '#{pid}' 2>/dev/null || true)"
  if [[ "$server_pid" =~ ^[0-9]+$ ]]; then
    pids+=("$server_pid")
  fi

  while IFS= read -r pane_pid; do
    if [[ "$pane_pid" =~ ^[0-9]+$ ]]; then
      while IFS= read -r pid; do
        pids+=("$pid")
      done < <(collect_descendants "$pane_pid")
    fi
  done < <(sudo -u "$tmux_user" tmux list-panes -a -F '#{pane_pid}' 2>/dev/null || true)

  printf '%s\n' "${pids[@]}" | awk 'NF && !seen[$0]++'
}

move_pid() {
  local pid="$1"
  if [ -d "/proc/$pid" ]; then
    echo "$pid" > "${target_cgroup}/cgroup.procs" 2>/dev/null || true
  fi
}

mapfile -t tmux_pids < <(collect_tmux_pids)
if [ "${#tmux_pids[@]}" -eq 0 ]; then
  echo "No tmux server or pane PIDs found; nothing to migrate."
  exit 0
fi

for pid in "${tmux_pids[@]}"; do
  move_pid "$pid"
done

remaining=()
for pid in "${tmux_pids[@]}"; do
  if [ ! -r "/proc/$pid/cgroup" ]; then
    continue
  fi
  if grep -Fxq "0::${web_cgroup}" "/proc/$pid/cgroup"; then
    remaining+=("$pid")
  fi
done

if [ "${#remaining[@]}" -gt 0 ]; then
  echo "Migration incomplete. These tmux/Agent PIDs remain in ${web_unit}: ${remaining[*]}" >&2
  exit 1
fi

echo "Migrated ${#tmux_pids[@]} tmux/Agent process(es) to ${unit}."
