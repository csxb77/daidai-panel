#!/bin/sh
# Install versioned CPython runtimes for Docker images.
#
# The panel creates per-version venvs at runtime, but Docker images must still
# provide the matching python3.10 / python3.11 / python3.12 bootstrap binaries.

set -eu

RUNTIME_FLAVOR=${1:-alpine}
TARGET_ARCH=${2:-}
TARGET_VARIANT=${3:-}
PYTHON_STANDALONE_RELEASE=${4:-20260602}
PYTHON_RUNTIME_310=${5:-3.10.20}
PYTHON_RUNTIME_311=${6:-3.11.15}
PYTHON_RUNTIME_312=${7:-3.12.13}

INSTALL_ROOT=${PYTHON_RUNTIME_ROOT:-/opt/daidai-python}
BASE_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_STANDALONE_RELEASE}"

log() {
  printf '[python-runtime] %s\n' "$*"
}

fetch() {
  url=$1
  out=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out" "$url"
  else
    log "curl/wget unavailable, skip Python runtime installation"
    return 1
  fi
}

python_platform() {
  flavor=$1
  arch=$2
  variant=$3

  case "${flavor}:${arch}" in
    alpine:amd64)
      printf '%s' 'x86_64-unknown-linux-musl'
      ;;
    alpine:arm64)
      printf '%s' 'aarch64-unknown-linux-musl'
      ;;
    debian:amd64)
      printf '%s' 'x86_64-unknown-linux-gnu'
      ;;
    debian:arm64)
      printf '%s' 'aarch64-unknown-linux-gnu'
      ;;
    debian:arm)
      case "$variant" in
        v7|'')
          printf '%s' 'armv7-unknown-linux-gnueabihf'
          ;;
      esac
      ;;
  esac
}

install_python() {
  minor=$1
  full_version=$2
  platform=$3

  archive="cpython-${full_version}+${PYTHON_STANDALONE_RELEASE}-${platform}-install_only.tar.gz"
  url="${BASE_URL}/${archive}"
  tmp="/tmp/${archive}"
  stage="${INSTALL_ROOT}/${minor}.tmp"
  dest="${INSTALL_ROOT}/${minor}"

  log "install Python ${minor} from ${archive}"
  rm -rf "$stage" "$dest"
  mkdir -p "$stage" "$INSTALL_ROOT"
  fetch "$url" "$tmp"
  tar -xzf "$tmp" -C "$stage"
  mv "$stage/python" "$dest"
  rm -rf "$stage" "$tmp"

  ln -sf "${dest}/bin/python${minor}" "/usr/local/bin/python${minor}"
  ln -sf "${dest}/bin/pip${minor}" "/usr/local/bin/pip${minor}"

  export PATH="${dest}/bin:${PATH}"
  export LD_LIBRARY_PATH="${dest}/lib${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"

  "python${minor}" --version
  "python${minor}" -m pip --version
}

PLATFORM=$(python_platform "$RUNTIME_FLAVOR" "$TARGET_ARCH" "$TARGET_VARIANT" || true)

if [ -z "$PLATFORM" ]; then
  log "no standalone CPython asset for flavor=${RUNTIME_FLAVOR} arch=${TARGET_ARCH} variant=${TARGET_VARIANT}; keep distro python only"
  exit 0
fi

install_python "3.10" "$PYTHON_RUNTIME_310" "$PLATFORM"
install_python "3.11" "$PYTHON_RUNTIME_311" "$PLATFORM"
install_python "3.12" "$PYTHON_RUNTIME_312" "$PLATFORM"

# 让通用 python3 / pip3 默认落到 3.12，减少运行层对系统 pip 的依赖。
ln -sf "${INSTALL_ROOT}/3.12/bin/python3.12" "/usr/local/bin/python3"
ln -sf "${INSTALL_ROOT}/3.12/bin/pip3.12" "/usr/local/bin/pip3"
ln -sf "${INSTALL_ROOT}/3.12/bin/pip3.12" "/usr/local/bin/pip"

log "Python runtimes installed under ${INSTALL_ROOT}"
