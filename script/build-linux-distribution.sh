#!/bin/sh

set -eu
umask 022

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_root="$repo/packages/opencode/dist-linux"
release_root="$output_root/matrix-release-linux"
portable="$release_root/Matrix-Code-Linux-x64"
cache="$repo/tmp/matrix-dependencies-linux"

node_version=24.13.0
node_archive="node-v$node_version-linux-x64.tar.xz"
node_url="https://nodejs.org/dist/v$node_version/$node_archive"
node_sha256=e798599612f4bb71333a3397ab0d095fd62214e115aea45aa858a145fc72d67e
omniroute_version=3.8.50
omniroute_archive="omniroute-$omniroute_version.tgz"
omniroute_url="https://registry.npmjs.org/omniroute/-/$omniroute_archive"
omniroute_sha256=738c58af1faae8c57eb643a939d1191f8d7e083d9295ef61687d2bff04878c29

require_tool() {
  command -v "$1" >/dev/null 2>&1 || {
    printf '%s\n' "Error: build tool is required: $1" >&2
    exit 1
  }
}

for tool in curl sha256sum tar xz file gzip; do require_tool "$tool"; done

if [ "$(uname -m)" != x86_64 ]; then
  printf '%s\n' 'Error: Stage 2 build must run on Linux x86_64.' >&2
  exit 1
fi

bun_bin=${BUN_BIN:-}
if [ -z "$bun_bin" ]; then
  if command -v bun >/dev/null 2>&1; then bun_bin=$(command -v bun)
  elif command -v bun.exe >/dev/null 2>&1; then bun_bin=$(command -v bun.exe)
  else
    printf '%s\n' 'Error: Bun is required only on the build host. Set BUN_BIN when it is not on PATH.' >&2
    exit 1
  fi
fi

download_verified() {
  dependency_url=$1
  dependency_path=$2
  dependency_sha=$3
  mkdir -p "$(dirname -- "$dependency_path")"
  if [ -f "$dependency_path" ] && printf '%s  %s\n' "$dependency_sha" "$dependency_path" | sha256sum -c - >/dev/null 2>&1; then
    printf '%s\n' "Reused verified dependency: $(basename -- "$dependency_path")"
    return
  fi
  dependency_partial="$dependency_path.partial"
  rm -f "$dependency_partial"
  curl --fail --location --silent --show-error "$dependency_url" --output "$dependency_partial"
  printf '%s  %s\n' "$dependency_sha" "$dependency_partial" | sha256sum -c - >/dev/null
  mv -f "$dependency_partial" "$dependency_path"
}

mkdir -p "$cache" "$output_root"
download_verified "$node_url" "$cache/$node_archive" "$node_sha256"
download_verified "$omniroute_url" "$cache/$omniroute_archive" "$omniroute_sha256"

node_root="$cache/node-v$node_version-linux-x64"
if [ ! -x "$node_root/bin/node" ]; then
  rm -rf "$node_root"
  tar -xJf "$cache/$node_archive" -C "$cache"
fi
printf '%s\n' "$node_sha256  $cache/$node_archive" | sha256sum -c - >/dev/null

runtime="$cache/omniroute-runtime-$omniroute_version-node-$node_version"
runtime_marker="$runtime/.complete"
if [ ! -f "$runtime_marker" ] || [ "$(cat "$runtime_marker")" != "$omniroute_version/$node_version" ]; then
  rm -rf "$runtime"
  mkdir -p "$runtime"
  PATH="$node_root/bin:$PATH" "$node_root/bin/node" "$node_root/lib/node_modules/npm/bin/npm-cli.js" \
    install --prefix "$runtime" "$cache/$omniroute_archive" --omit=dev --no-audit --no-fund \
    --package-lock=false --legacy-peer-deps --progress=false
  test -f "$runtime/node_modules/omniroute/dist/server-ws.mjs"
  printf '%s\n' "$omniroute_version/$node_version" > "$runtime_marker"
else
  printf '%s\n' "Reused bundled runtime: OmniRoute $omniroute_version"
fi

printf '%s\n' 'Building Matrix Code Linux x64...'
build_install_flag=''
if [ -n "$(find "$repo/node_modules/.bun" -maxdepth 1 -type d -name '@opentui+core-linux-x64@*' -print -quit)" ] && \
  [ -n "$(find "$repo/node_modules/.bun" -maxdepth 1 -type d -name '@ff-labs+fff-bin-linux-x64-gnu@*' -print -quit)" ] && \
  [ -n "$(find "$repo/node_modules/.bun" -maxdepth 1 -type d -name '@parcel+watcher-linux-x64-glibc@*' -print -quit)" ]; then
  build_install_flag=--skip-install
fi
(cd "$repo/packages/opencode" && "$bun_bin" run build \
  --target=linux-x64 --output-dir=dist-linux/cli --skip-embed-web-ui $build_install_flag)

matrix_source="$output_root/cli/opencode-linux-x64/bin/opencode"
if [ ! -f "$matrix_source" ]; then
  printf '%s\n' "Error: Linux x64 Matrix binary was not produced: $matrix_source" >&2
  exit 1
fi

case "$release_root" in "$repo"/*) ;; *) printf '%s\n' 'Error: release path escaped the repository.' >&2; exit 1 ;; esac
rm -rf "$release_root"
mkdir -p "$portable/omniroute/app" "$portable/templates"
cp "$matrix_source" "$portable/matrix"
cp "$repo/distribution/linux/matrix.sh" "$portable/matrix.sh"
cp "$repo/distribution/linux/README.txt" "$portable/README.txt"
cp "$repo/distribution/linux/templates/opencode.omniroute.jsonc" "$portable/templates/opencode.omniroute.jsonc"
cp "$repo/LICENSE" "$portable/LICENSE"
cp "$node_root/bin/node" "$portable/omniroute/node"
if ! cp -al "$runtime/node_modules" "$portable/omniroute/app/node_modules" 2>/dev/null; then
  rm -rf "$portable/omniroute/app/node_modules"
cp -a "$runtime/node_modules" "$portable/omniroute/app/node_modules"
fi
find "$portable" -type f -name .env -delete
chmod 755 "$portable/matrix" "$portable/matrix.sh" "$portable/omniroute/node"

file "$portable/matrix" | grep -E 'ELF 64-bit.*x86-64' >/dev/null
file "$portable/omniroute/node" | grep -E 'ELF 64-bit.*x86-64' >/dev/null
sh -n "$portable/matrix.sh"

if find "$portable" -type d -name .matrix -o -type f \( -name 'auth.json' -o -name 'storage.sqlite' -o -name '*.db' -o -name '*.sqlite' -o -name '*.log' -o -name '.env' \) | grep . >/dev/null; then
  printf '%s\n' 'Error: portable contains runtime state, a personal database, logs, or .env.' >&2
  exit 1
fi
if grep -RIE '(C:\\Users\\|/home/[^/[:space:]]+/|sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|xoxb-[A-Za-z0-9-]{16,})' "$portable" >/dev/null 2>&1; then
  printf '%s\n' 'Error: portable contains a private absolute path or secret-like value.' >&2
  exit 1
fi

archive="$release_root/Matrix-Code-Linux-x64.tar.gz"
(cd "$release_root" && tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
  --mode='u+rwX,go+rX,go-w' \
  -cf - Matrix-Code-Linux-x64 | gzip -n > "$archive")
(cd "$release_root" && sha256sum Matrix-Code-Linux-x64.tar.gz > SHA256SUMS-Linux.txt)
(cd "$release_root" && sha256sum -c SHA256SUMS-Linux.txt >/dev/null)
tar -tzf "$archive" >/dev/null
tar -tvzf "$archive" | grep -E '^-rwx[^ ]* 0/0 +[^ ]+ .*/matrix$' >/dev/null
tar -tvzf "$archive" | grep -E '^-rwx[^ ]* 0/0 +[^ ]+ .*/matrix\.sh$' >/dev/null
tar -tvzf "$archive" | grep -E '^-rwx[^ ]* 0/0 +[^ ]+ .*/omniroute/node$' >/dev/null

printf '%s\n' "Linux x64 portable: $portable"
printf '%s\n' "Linux x64 archive: $archive"
printf '%s\n' "Checksums: $release_root/SHA256SUMS-Linux.txt"
