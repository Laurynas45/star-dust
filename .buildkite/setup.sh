# Sourced by .buildkite/pipeline.yml on Buildkite hosted agents or the default queue.
# Node 20+ comes from the public image in pipeline.yml when that image is used.
# Otherwise this installs Node 20 with nvm. The demo step calls install_ffmpeg.

set -euo pipefail

export CI=true
export DEBIAN_FRONTEND=noninteractive
unset FAL_KEY REPLICATE_API_TOKEN

apt_install() {
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "apt-get is required to install: $*" >&2
    exit 1
  fi
  if [ "$(id -u)" -eq 0 ]; then
    apt-get update
    apt-get install -y "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get update
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
  else
    echo "Need root or sudo to install: $*" >&2
    exit 1
  fi
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    local major
    major="$(node -p 'parseInt(process.versions.node, 10)')"
    if [ "$major" -ge 20 ]; then
      echo "Node $(node --version)"
      return 0
    fi
    echo "Node $(node --version) is below 20; installing Node 20 with nvm"
  else
    echo "Node 20+ is not on PATH; installing Node 20 with nvm"
  fi

  if [ -z "${HOME:-}" ]; then
    echo "HOME is not set; nvm needs a home directory" >&2
    exit 1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    apt_install curl ca-certificates
  fi
  if ! command -v git >/dev/null 2>&1; then
    apt_install git ca-certificates
  fi

  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
  fi

  # nvm uses unset variables and pipes; don't let those abort the step.
  set +u +o pipefail
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
  nvm install 20
  nvm use 20
  set -u -o pipefail
  hash -r

  echo "Node $(node --version)"
}

ensure_build_tools() {
  if command -v make >/dev/null 2>&1 && command -v g++ >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  apt_install python3 make g++
}

install_ffmpeg() {
  if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
    echo "ffmpeg: $(command -v ffmpeg)"
    echo "ffprobe: $(command -v ffprobe)"
    return 0
  fi
  apt_install ffmpeg
  command -v ffmpeg
  command -v ffprobe
}

ensure_node
ensure_build_tools
