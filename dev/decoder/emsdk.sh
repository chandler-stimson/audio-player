#! /bin/bash
# Installs the emsdk that the checked-in decoder binaries were built with.
# The emsdk downloads prebuilt glibc toolchains; on a musl host they run
# under the gcompat layer, and build.sh points the emsdk at the node of the
# host for the same reason.
#
# Requirements: git, python3, curl (all widely present); a C toolchain is
# not needed, the sdk ships its own.
#
# Usage: bash emsdk.sh [install-directory]

set -e

DIR="${1:-${TMPDIR:-/tmp}/audio-player-decoder-emsdk}"
VERSION=3.1.61

if [ ! -d "$DIR/emsdk" ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk "$DIR/emsdk"
fi

cd "$DIR/emsdk"
./emsdk install "$VERSION"
./emsdk activate "$VERSION"

echo
echo "The emsdk $VERSION is installed. To use it in this shell:"
echo "  source \"$DIR/emsdk/emsdk_env.sh\""
echo
echo "Then build the decoder with:"
echo "  bash \"$(cd "$(dirname "$0")" && pwd)/build.sh\""
