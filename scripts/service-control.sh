#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WEB_UNIT="agentmobile.service"
TMUX_UNIT="agentmobile-tmux.service"
IM_UNIT="agentmobile-im.service"

resolve_node_binary() {
  if [ -n "${NODE_BINARY:-}" ] && [ -x "${NODE_BINARY:-}" ]; then
    printf '%s\n' "$NODE_BINARY"
    return 0
  fi
  command -v node
}

resolve_npm_binary() {
  if [ -n "${NPM_BINARY:-}" ] && [ -x "${NPM_BINARY:-}" ]; then
    printf '%s\n' "$NPM_BINARY"
    return 0
  fi
  command -v npm
}

build_runtime_path() {
  local home_dir npm_prefix
  home_dir="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6 2>/dev/null || printf '/home/%s' "$(id -un)")}"
  printf '%s\n' \
    "${PATH:-}:$home_dir/.local/bin:$home_dir/.opencode/bin:$home_dir/bin:$home_dir/.npm-global/bin:$home_dir/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin" \
    | awk -F: '{for(i=1;i<=NF;i++) if(length($i) && !seen[$i]++) out=(out?out":":"")$i} END{print out}'
}

render_unit_to() {
  local template="$1"
  local dest="$2"
  local node_binary npm_binary runtime_path service_user service_group
  node_binary="$(resolve_node_binary)" || die "node binary not found"
  npm_binary="$(resolve_npm_binary)" || die "npm binary not found"
  runtime_path="$(build_runtime_path)"
  service_user="${SUDO_USER:-${USER:-$(id -un)}}"
  service_group="$(id -gn "$service_user" 2>/dev/null || printf '%s' "$service_user")"

  sed \
    -e "s|__ROOT__|$ROOT|g" \
    -e "s|__USER__|$service_user|g" \
    -e "s|__GROUP__|$service_group|g" \
    -e "s|__NODE_BINARY__|$node_binary|g" \
    -e "s|__NPM_BINARY__|$npm_binary|g" \
    -e "s|__RUNTIME_PATH__|$runtime_path|g" \
    "$template" > "$dest"
}

die() {
  echo "error: $*" >&2
  exit 1
}

warn() {
  echo "warn: $*" >&2
}

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

read_env_value() {
  local key="$1"
  local line value

  [ -f "$ROOT/.env" ] || return 0
  line="$(grep -E "^[[:space:]]*${key}=" "$ROOT/.env" | tail -n 1 || true)"
  [ -n "$line" ] || return 0

  value="${line#*=}"
  value="$(trim "$value")"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s\n' "$value"
}

has_systemd() {
  command -v systemctl >/dev/null 2>&1 \
    && [ -d /run/systemd/system ] \
    && systemctl show-environment >/dev/null 2>&1
}

service_unit_exists() {
  systemctl cat "$1" >/dev/null 2>&1
}

pm2_process_exists() {
  command -v pm2 >/dev/null 2>&1 && pm2 describe "$1" >/dev/null 2>&1
}

im_enabled() {
  local value
  value="$(read_env_value IM_BRIDGE_ENABLED | tr '[:upper:]' '[:lower:]')"
  case "$value" in
    true|1|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

managed_by_systemd() {
  has_systemd && service_unit_exists "$WEB_UNIT"
}

managed_by_pm2() {
  pm2_process_exists agentmobile
}

port() {
  local value
  value="$(read_env_value PORT)"
  printf '%s\n' "${value:-5000}"
}

print_help() {
  cat <<'EOF'
Usage: scripts/service-control.sh <command>

Canonical service commands:
  status              Show managed service status
  logs                Follow logs for web, tmux runtime, and IM bridge
  verify              Check managed services and HTTP reachability
  install-units       Copy repo systemd units to /etc/systemd/system and daemon-reload

Normal pull/deploy paths:
  pull-web            git pull --ff-only, install deps, build frontend, restart web only
  deploy-web          install deps, build frontend, restart web only
  pull-all            git pull --ff-only, build web + IM, restart web and IM only
  deploy-all          build web + IM, restart web and IM only

Individual service actions:
  restart-web         Restart agentmobile.service or PM2 agentmobile
  deploy-im           type-check IM bridge and restart managed IM service
  restart-im          Restart agentmobile-im.service or PM2 agentmobile-im
  migrate-tmux        Move existing tmux/Agent processes into agentmobile-tmux.service
  restart-tmux        Refuse by default; use restart-tmux --force only in maintenance

Rules:
  - Normal code pulls restart web and optional IM only.
  - Do not restart agentmobile-tmux.service during normal deploys.
  - agentmobile-tmux.service owns persistent tmux sessions and running Agent processes.
EOF
}

status() {
  if has_systemd; then
    local units=()
    service_unit_exists "$WEB_UNIT" && units+=("$WEB_UNIT")
    service_unit_exists "$TMUX_UNIT" && units+=("$TMUX_UNIT")
    service_unit_exists "$IM_UNIT" && units+=("$IM_UNIT")

    if [ "${#units[@]}" -eq 0 ]; then
      warn "no agentmobile systemd units are installed"
      return 1
    fi

    systemctl status "${units[@]}" --no-pager || true
    return 0
  fi

  if command -v pm2 >/dev/null 2>&1; then
    pm2 status
    return 0
  fi

  die "neither systemd nor PM2 is available"
}

logs() {
  if has_systemd; then
    exec journalctl -u "$WEB_UNIT" -u "$TMUX_UNIT" -u "$IM_UNIT" -f
  fi

  if command -v pm2 >/dev/null 2>&1; then
    exec pm2 logs agentmobile
  fi

  die "neither systemd nor PM2 is available"
}

verify() {
  local url="http://127.0.0.1:$(port)/"
  local attempt

  if managed_by_systemd; then
    systemctl is-active --quiet "$WEB_UNIT" || die "$WEB_UNIT is not active"
    service_unit_exists "$TMUX_UNIT" || die "$TMUX_UNIT is not installed"
    systemctl is-active --quiet "$TMUX_UNIT" || die "$TMUX_UNIT is not active"

    if im_enabled; then
      if service_unit_exists "$IM_UNIT"; then
        systemctl is-active --quiet "$IM_UNIT" || die "$IM_UNIT is not active while IM_BRIDGE_ENABLED=true"
      else
        warn "IM_BRIDGE_ENABLED=true but $IM_UNIT is not installed"
      fi
    fi
  elif managed_by_pm2; then
    pm2 describe agentmobile >/dev/null || die "PM2 process agentmobile is missing"
  else
    die "agentmobile is not managed by systemd or PM2"
  fi

  if command -v curl >/dev/null 2>&1; then
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
      if curl -fsSI --max-time 10 "$url" >/dev/null 2>&1; then
        echo "ok: web reachable at $url"
        return 0
      fi
      sleep 1
    done
    die "web service is not reachable at $url"
  else
    warn "curl not found; skipped HTTP reachability check for $url"
  fi
}

restart_web_only() {
  if managed_by_systemd; then
    as_root systemctl restart "$WEB_UNIT"
    return 0
  fi

  if managed_by_pm2; then
    pm2 restart agentmobile
    return 0
  fi

  die "agentmobile is not managed by systemd or PM2"
}

restart_web() {
  restart_web_only
  verify
}

restart_im_only() {
  if has_systemd && service_unit_exists "$IM_UNIT"; then
    as_root systemctl restart "$IM_UNIT"
    return 0
  fi

  if pm2_process_exists agentmobile-im; then
    pm2 restart agentmobile-im
    return 0
  fi

  die "no managed IM service found; use npm run start:im for foreground IM bridge"
}

restart_im_optional() {
  if has_systemd && service_unit_exists "$IM_UNIT"; then
    as_root systemctl restart "$IM_UNIT"
  elif pm2_process_exists agentmobile-im; then
    pm2 restart agentmobile-im
  else
    echo "info: no managed IM service found; skipping IM restart"
  fi
}

restart_im() {
  restart_im_only
  verify
}

deploy_web() {
  npm install --include=dev
  (cd frontend && npm install --include=dev && npm run build)
  restart_web
}

pull_web() {
  git pull --ff-only
  deploy_web
}

deploy_im() {
  npm install --include=dev
  npm run build:im
  restart_im
}

deploy_all() {
  npm install --include=dev
  (cd frontend && npm install --include=dev && npm run build)
  npm run build:im
  restart_web_only
  restart_im_optional
  verify
}

pull_all() {
  git pull --ff-only
  deploy_all
}

install_units() {
  has_systemd || die "systemd is not available on this host"

  local units=("$TMUX_UNIT" "$WEB_UNIT" "$IM_UNIT")
  if service_unit_exists "agentmobile-5001.service" && [ -f "$ROOT/agentmobile-5001.service" ]; then
    units+=("agentmobile-5001.service")
  fi

  for unit in "${units[@]}"; do
    [ -f "$ROOT/$unit" ] || continue
    local rendered
    rendered="$(mktemp)"
    render_unit_to "$ROOT/$unit" "$rendered"
    as_root cp "$rendered" "/etc/systemd/system/$unit"
    rm -f "$rendered"
    echo "installed: $unit"
  done

  as_root systemctl daemon-reload
  echo "ok: systemd daemon reloaded"
  echo "next: restart only the service whose code/unit changed"
}

migrate_tmux() {
  has_systemd || die "systemd is not available on this host"
  as_root "$ROOT/scripts/migrate-tmux-runtime.sh"
  verify
}

restart_tmux() {
  if [ "${1:-}" != "--force" ]; then
    cat >&2 <<'EOF'
Refusing to restart agentmobile-tmux.service.

That service owns persistent tmux sessions and running Agent processes.
Use this only in a maintenance window:

  scripts/service-control.sh restart-tmux --force
EOF
    exit 2
  fi

  has_systemd || die "systemd is not available on this host"
  service_unit_exists "$TMUX_UNIT" || die "$TMUX_UNIT is not installed"
  as_root systemctl restart "$TMUX_UNIT"
  verify
}

command="${1:-help}"
shift || true

case "$command" in
  help|-h|--help) print_help ;;
  status) status ;;
  logs) logs ;;
  verify) verify ;;
  install-units) install_units ;;
  restart-web) restart_web ;;
  deploy-web) deploy_web ;;
  pull-web) pull_web ;;
  restart-im) restart_im ;;
  deploy-im) deploy_im ;;
  deploy-all) deploy_all ;;
  pull-all) pull_all ;;
  migrate-tmux) migrate_tmux ;;
  restart-tmux) restart_tmux "$@" ;;
  *) print_help >&2; die "unknown command: $command" ;;
esac
