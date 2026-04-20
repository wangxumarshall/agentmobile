#!/bin/bash
# Common helpers for agentmobile interactive agent launchers

AGENTMOBILE_NO_PROFILE="__none__"

agentmobile_build_path() {
  local home_dir="${HOME:-/home/ubuntu}"
  local extra=(
    "$home_dir/.local/bin"
    "$home_dir/.opencode/bin"
    "$home_dir/bin"
    "$home_dir/.npm-global/bin"
    "$home_dir/.local/share/pnpm"
    "/usr/local/bin"
    "/usr/bin"
    "/bin"
  )

  local current="${PATH:-}"
  for dir in "${extra[@]}"; do
    case ":$current:" in
      *":$dir:"*) ;;
      *) current="${current:+$current:}$dir" ;;
    esac
  done
  export PATH="$current"
}

agentmobile_has_profile() {
  [ -n "$1" ] && [ "$1" != "$AGENTMOBILE_NO_PROFILE" ]
}

agentmobile_login_shell() {
  local preferred="${SHELL:-}"
  case "$(basename "$preferred")" in
    zsh|bash)
      if command -v "$preferred" >/dev/null 2>&1; then
        command -v "$preferred"
        return 0
      fi
      ;;
  esac

  if command -v zsh >/dev/null 2>&1; then
    command -v zsh
    return 0
  fi

  if command -v bash >/dev/null 2>&1; then
    command -v bash
    return 0
  fi

  command -v sh
}

agentmobile_bootstrap_shell_env() {
  local script_path="$1"
  shift

  if [ "${AGENTMOBILE_ENV_BOOTSTRAPPED:-0}" = "1" ]; then
    return 0
  fi

  local shell_bin
  shell_bin="$(agentmobile_login_shell)"

  local command="export AGENTMOBILE_ENV_BOOTSTRAPPED=1;"
  local quoted_shell
  printf -v quoted_shell '%q' "$shell_bin"
  command+=" export AGENTMOBILE_ENV_SHELL=${quoted_shell};"
  command+=" exec bash"
  local arg
  printf -v arg ' %q' "$script_path"
  command+="$arg"
  for arg in "$@"; do
    printf -v arg ' %q' "$arg"
    command+="$arg"
  done

  exec "$shell_bin" -ic "$command"
}

agentmobile_resolve_binary() {
  local candidate
  for candidate in "$@"; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
}

agentmobile_cli_error_and_shell() {
  local label="$1"
  shift
  echo "[agentmobile] ${label} command not found: $*"
  echo "[agentmobile] Install the CLI and restart the session."
  exec bash -i
}

agentmobile_exit_menu() {
  local label="$1"
  while true; do
    stty sane 2>/dev/null || true
    echo ""
    echo "[agentmobile] ${label} exited.  r=restart  b=bash shell  q=quit window"
    IFS= read -r -n 1 REPLY || REPLY="q"
    if [ "$REPLY" = "" ]; then
      echo ""
      return 0
    fi
    echo ""
    case "$REPLY" in
      r|R) return 0 ;;
      b) exec bash -i ;;
      B) exec bash -i ;;
      q|Q) exit 0 ;;
      *) echo "[agentmobile] Invalid option: ${REPLY}" ;;
    esac
  done
}
