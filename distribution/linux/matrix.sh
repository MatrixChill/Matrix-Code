#!/bin/sh

set -eu
umask 077

matrix_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
matrix_bin="$matrix_root/matrix"
node_bin="$matrix_root/omniroute/node"
omniroute_entry="$matrix_root/omniroute/app/node_modules/omniroute/dist/server-ws.mjs"

if [ ! -x "$matrix_bin" ]; then
  printf '%s\n' "Error: Matrix Code executable not found: $matrix_bin" >&2
  exit 1
fi

# Metadata probes must not initialize portable state or start services.
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  exec "$matrix_bin" "$@"
fi

if [ ! -x "$node_bin" ] || [ ! -f "$omniroute_entry" ]; then
  printf '%s\n' 'Error: bundled OmniRoute/Node runtime is incomplete.' >&2
  exit 1
fi

matrix_home="$matrix_root/.matrix"
state_dir="$matrix_home/state"
export MATRIX_PORTABLE_ROOT="$matrix_root"
export XDG_CONFIG_HOME="$matrix_home/config"
export XDG_DATA_HOME="$matrix_home/data"
export XDG_CACHE_HOME="$matrix_home/cache"
export XDG_STATE_HOME="$state_dir"
export OPENCODE_CONFIG_DIR="$XDG_CONFIG_HOME/opencode"
export OPENCODE_DISABLE_AUTOUPDATE=true
export OMNIROUTE_BASE_URL="${OMNIROUTE_BASE_URL:-http://127.0.0.1:20128/v1}"

mkdir -p "$OPENCODE_CONFIG_DIR" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$state_dir"
chmod 700 "$matrix_home" "$OPENCODE_CONFIG_DIR" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$state_dir"

config_file="$OPENCODE_CONFIG_DIR/opencode.jsonc"
template_file="$matrix_root/templates/opencode.omniroute.jsonc"
if [ ! -f "$config_file" ] && [ -f "$template_file" ]; then
  cp "$template_file" "$config_file"
  chmod 600 "$config_file"
fi

random_key() {
  "$node_bin" -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))'
}

read_secret() {
  secret_path=$1
  [ -f "$secret_path" ] || return 1
  chmod 600 "$secret_path"
  IFS= read -r secret_value < "$secret_path" || return 1
  [ -n "$secret_value" ] || return 1
  printf '%s' "$secret_value"
}

write_secret() {
  secret_path=$1
  secret_value=$2
  secret_tmp="$secret_path.tmp.$$"
  (umask 077 && printf '%s\n' "$secret_value" > "$secret_tmp")
  chmod 600 "$secret_tmp"
  mv -f "$secret_tmp" "$secret_path"
}

probe_http() {
  MATRIX_PROBE_URL=$1 MATRIX_PROBE_KIND=$2 "$node_bin" -e '
    const http = require("node:http")
    const url = new URL(process.env.MATRIX_PROBE_URL)
    const key = process.env.MATRIX_PROBE_KIND === "omniroute-auth"
      ? process.env.OMNIROUTE_API_KEY
      : process.env.MATRIX_PROBE_KIND === "matrix-auth"
        ? process.env.MATRIX_API_KEY
        : undefined
    const request = http.get(url, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      timeout: 2000,
    }, (response) => {
      let body = ""
      response.setEncoding("utf8")
      response.on("data", (chunk) => { body += chunk })
      response.on("end", () => {
        if (response.statusCode !== 200) process.exit(1)
        if (process.env.MATRIX_PROBE_KIND !== "omniroute-live") process.exit(0)
        try { process.exit(JSON.parse(body).status === "ok" ? 0 : 1) } catch { process.exit(1) }
      })
    })
    request.on("timeout", () => request.destroy())
    request.on("error", () => process.exit(1))
  ' >/dev/null 2>&1
}

probe_port() {
  MATRIX_PROBE_PORT=$1 "$node_bin" -e '
    const net = require("node:net")
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(process.env.MATRIX_PROBE_PORT) })
    socket.setTimeout(1000)
    socket.on("connect", () => { socket.destroy(); process.exit(0) })
    socket.on("timeout", () => socket.destroy())
    socket.on("error", () => process.exit(1))
  ' >/dev/null 2>&1
}

wait_ready() {
  ready_kind=$1
  ready_url=$2
  ready_count=0
  while [ "$ready_count" -lt 120 ]; do
    if probe_http "$ready_url" "$ready_kind"; then return 0; fi
    ready_count=$((ready_count + 1))
    sleep 0.5
  done
  return 1
}

process_matches() {
  match_pid=$1
  match_marker=$2
  [ -r "/proc/$match_pid/cmdline" ] || return 1
  tr '\000' ' ' < "/proc/$match_pid/cmdline" | grep -F "$match_marker" >/dev/null 2>&1
}

stop_owned() {
  owned_name=$1
  owned_pid=$2
  owned_marker=$3
  owned_group=$4
  owned_pid_file=$5

  if [ -n "$owned_pid" ] && kill -0 "$owned_pid" 2>/dev/null; then
    if process_matches "$owned_pid" "$owned_marker"; then
      printf '%s\n' "Stopping $owned_name..."
      if [ "$owned_group" -eq 1 ]; then kill -TERM "-$owned_pid" 2>/dev/null || true
      else kill -TERM "$owned_pid" 2>/dev/null || true
      fi
      stop_count=0
      while kill -0 "$owned_pid" 2>/dev/null && [ "$stop_count" -lt 20 ]; do
        stop_count=$((stop_count + 1))
        sleep 0.1
      done
      if kill -0 "$owned_pid" 2>/dev/null; then
        if [ "$owned_group" -eq 1 ]; then kill -KILL "-$owned_pid" 2>/dev/null || true
        else kill -KILL "$owned_pid" 2>/dev/null || true
        fi
      fi
    else
      printf '%s\n' "Warning: refusing to stop PID $owned_pid because it no longer matches $owned_name." >&2
    fi
  fi
  rm -f "$owned_pid_file"
}

omniroute_pid=''
omniroute_group=0
matrix_api_pid=''
matrix_api_group=0
cleanup() {
  stop_owned 'Matrix API' "$matrix_api_pid" 'matrix-api' "$matrix_api_group" "$matrix_root/.matrix/matrix-api.pid"
  stop_owned 'OmniRoute' "$omniroute_pid" 'omniroute' "$omniroute_group" "$matrix_root/.matrix/omniroute.pid"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

matrix_key_file="$state_dir/matrix-api.key"
if [ "${MATRIX_API_ENABLED:-true}" != 'false' ] && [ "${MATRIX_API_ENABLED:-true}" != '0' ]; then
  if [ -z "${MATRIX_API_KEY:-}" ]; then
    MATRIX_API_KEY=$(read_secret "$matrix_key_file" || true)
    if [ -z "$MATRIX_API_KEY" ]; then
      MATRIX_API_KEY=$(random_key)
      write_secret "$matrix_key_file" "$MATRIX_API_KEY"
      printf '%s\n' 'Matrix Code created a private local Matrix API credential.'
    fi
  elif [ ! -f "$matrix_key_file" ]; then
    write_secret "$matrix_key_file" "$MATRIX_API_KEY"
  fi
  export MATRIX_API_ENABLED=true MATRIX_API_KEY
fi

omniroute_key_file="$state_dir/omniroute-api.key"
omniroute_storage_file="$state_dir/omniroute-storage.key"
if probe_http 'http://127.0.0.1:20128/api/health/ping' 'omniroute-live'; then
  if [ -z "${OMNIROUTE_API_KEY:-}" ]; then OMNIROUTE_API_KEY=$(read_secret "$omniroute_key_file" || true); fi
  if [ -z "${OMNIROUTE_API_KEY:-}" ] || ! probe_http 'http://127.0.0.1:20128/v1/models' 'omniroute-auth'; then
    printf '%s\n' 'Error: OmniRoute is running, but no compatible local credential is available.' >&2
    exit 1
  fi
  if [ ! -f "$omniroute_key_file" ]; then write_secret "$omniroute_key_file" "$OMNIROUTE_API_KEY"; fi
  export OMNIROUTE_API_KEY
  printf '%s\n' 'OmniRoute already active and authenticated. Reusing it.'
else
  if probe_port 20128; then
    printf '%s\n' 'Error: port 20128 is occupied by a service that is not a ready OmniRoute.' >&2
    exit 1
  fi
  if [ -z "${OMNIROUTE_API_KEY:-}" ]; then OMNIROUTE_API_KEY=$(read_secret "$omniroute_key_file" || true); fi
  if [ -z "${OMNIROUTE_API_KEY:-}" ]; then
    OMNIROUTE_API_KEY=$(random_key)
    write_secret "$omniroute_key_file" "$OMNIROUTE_API_KEY"
  elif [ ! -f "$omniroute_key_file" ]; then
    write_secret "$omniroute_key_file" "$OMNIROUTE_API_KEY"
  fi
  STORAGE_ENCRYPTION_KEY=$(read_secret "$omniroute_storage_file" || true)
  if [ -z "$STORAGE_ENCRYPTION_KEY" ]; then
    STORAGE_ENCRYPTION_KEY=$(random_key)
    write_secret "$omniroute_storage_file" "$STORAGE_ENCRYPTION_KEY"
  fi
  export OMNIROUTE_API_KEY STORAGE_ENCRYPTION_KEY REQUIRE_API_KEY=true
  export DATA_DIR="$XDG_CONFIG_HOME/omniroute"
  export OMNIROUTE_SERVER_HOST=127.0.0.1 HOSTNAME=127.0.0.1
  export OMNIROUTE_PORT=20128 PORT=20128 API_PORT=20128 DASHBOARD_PORT=20128
  export NODE_ENV=production OMNIROUTE_NO_UPDATE_NOTIFIER=1 OMNIROUTE_HEADLESS=true NO_LOG_API_KEY_IDS=env-key
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  printf '%s\n' 'Starting OmniRoute...'
  if command -v setsid >/dev/null 2>&1; then
    (cd "$matrix_root/omniroute" && exec setsid "$node_bin" "$omniroute_entry") >/dev/null 2>&1 &
    omniroute_group=1
  else
    (cd "$matrix_root/omniroute" && exec "$node_bin" "$omniroute_entry") >/dev/null 2>&1 &
  fi
  omniroute_pid=$!
  printf '%s\n' "$omniroute_pid" > "$matrix_root/.matrix/omniroute.pid"
  chmod 600 "$matrix_root/.matrix/omniroute.pid"
  if ! wait_ready 'omniroute-auth' 'http://127.0.0.1:20128/v1/models'; then
    printf '%s\n' 'Error: OmniRoute did not become authenticated and ready.' >&2
    exit 1
  fi
fi

matrix_api_port=${MATRIX_API_PORT:-20260}
case "$matrix_api_port" in
  ''|*[!0-9]*) printf '%s\n' 'Error: MATRIX_API_PORT must be an integer from 1 to 65535.' >&2; exit 1 ;;
esac
if [ "$matrix_api_port" -lt 1 ] || [ "$matrix_api_port" -gt 65535 ]; then
  printf '%s\n' 'Error: MATRIX_API_PORT must be an integer from 1 to 65535.' >&2
  exit 1
fi
export MATRIX_API_PORT="$matrix_api_port"
if [ "${MATRIX_API_ENABLED:-true}" = 'true' ]; then
  matrix_api_url="http://127.0.0.1:$matrix_api_port/v1/models"
  if probe_http "$matrix_api_url" 'matrix-auth'; then
    printf '%s\n' 'Matrix API already active and authenticated. Reusing it.'
  else
    if probe_port "$matrix_api_port"; then
      printf '%s\n' "Error: port $matrix_api_port is occupied or rejects the Matrix API credential." >&2
      exit 1
    fi
    printf '%s\n' 'Starting Matrix API...'
    if command -v setsid >/dev/null 2>&1; then
      setsid "$matrix_bin" matrix-api >/dev/null 2>&1 &
      matrix_api_group=1
    else
      "$matrix_bin" matrix-api >/dev/null 2>&1 &
    fi
    matrix_api_pid=$!
    printf '%s\n' "$matrix_api_pid" > "$matrix_root/.matrix/matrix-api.pid"
    chmod 600 "$matrix_root/.matrix/matrix-api.pid"
    if ! wait_ready 'matrix-auth' "$matrix_api_url"; then
      printf '%s\n' 'Error: Matrix API did not become authenticated and ready.' >&2
      exit 1
    fi
  fi
fi

set +e
"$matrix_bin" "$@"
matrix_exit=$?
set -e
exit "$matrix_exit"
