#! /bin/bash
# Builds the FFmpeg-based wasm decoder (decoder.js + decoder.wasm) from
# src/decoder.c. Derived from https://github.com/chandler-stimson/decoder.js
#
# Changes over the original build:
#   * -O3 instead of -Oz (decode speed over bundle size)
#   * -msimd128 (clang auto-vectorizes the PCM conversion loops)
#   * exports the incremental streaming API next to the batch entry point
#   * pins the FFmpeg version (the source uses the pre-ch_layout API, which
#     the releases from n7.0 on no longer have)
#   * falls back to a binaryen-free link when the wasm-opt of the emsdk
#     cannot run on this host (a musl host runs the glibc binaryen under
#     the gcompat layer, which segfaults on inputs of this size)
#
# Requirements: emsdk (emconfigure, emmake, emcc; see emsdk.sh), git, make,
# pkg-config.
#
# Usage: bash build.sh [--no-copy] [build-directory]
#   --no-copy  leave the artifacts in the build directory instead of
#              replacing the checked-in binaries of the extension

set -e

COPY=1
BUILD=""
for arg in "$@"; do
  case "$arg" in
    --no-copy) COPY=0 ;;
    *) BUILD="$arg" ;;
  esac
done
BUILD="${BUILD:-${TMPDIR:-/tmp}/audio-player-decoder-build}"

SRC="$(cd "$(dirname "$0")" && pwd)"
V2="$SRC/../../v2/data/player/decoder"

# FFmpeg looks for pkg-config during its configure; hosts without apt (a
# musl host uses apk) have to provide it on their own
if ! command -v pkg-config > /dev/null; then
  if command -v apt-get > /dev/null; then
    apt-get update
    apt-get install -y pkg-config
  fi
fi

# the emsdk binaries are glibc builds; on a musl host they run under the
# gcompat layer except the bundled node, which the node of the host replaces
if ldd --version 2>&1 | head -1 | grep -qi musl; then
  export EM_NODE_JS="$(command -v node)"
  # gcompat is a library, so its presence is asked from the package manager
  if command -v apk > /dev/null && ! apk info -e gcompat > /dev/null 2>&1; then
    apk add --no-cache gcompat libstdc++ || \
      echo "build.sh: install gcompat and libstdc++ with apk, the emsdk tools need them" >&2
  fi
fi

# pin the FFmpeg version
if [ ! -d "$BUILD/FFmpeg" ]; then
  git clone --depth 1 --branch n4.0.2 https://github.com/FFmpeg/FFmpeg "$BUILD/FFmpeg"
fi

pushd "$BUILD/FFmpeg" > /dev/null

if [ ! -f config.mak ]; then
  emconfigure ./configure \
    --cc=emcc \
    --cxx=em++ \
    --objcc=emcc \
    --dep-cc=emcc \
    --nm="llvm-nm -g" \
    --ranlib=emranlib \
    --enable-cross-compile \
    --target-os=none \
    --arch=x86 \
    --disable-runtime-cpudetect \
    --disable-asm \
    --disable-fast-unaligned \
    --disable-pthreads \
    --disable-w32threads \
    --disable-os2threads \
    --disable-debug \
    --disable-stripping \
    --disable-doc \
    --disable-safe-bitstream-reader \
    \
    --disable-all \
    --enable-decoders \
    --enable-demuxers \
    --enable-avcodec \
    --enable-avformat \
    --disable-network \
    --disable-d3d11va \
    --disable-dxva2 \
    --disable-vaapi \
    --disable-vdpau \
    --enable-protocol=file \
    --disable-bzlib \
    --disable-iconv \
    --disable-libxcb \
    --disable-lzma \
    --disable-sdl2 \
    --disable-xlib
fi

JOBS=$(nproc 2> /dev/null || echo 4)
[ "$JOBS" -gt 8 ] && JOBS=8
emmake make -j"$JOBS"

EXPORTS='["_decoder", "_decoder_open", "_decoder_pull", "_decoder_seek", "_decoder_close"]'

link_full() {
  emcc -O3 -msimd128 \
    -I. \
    -Llibavcodec -Llibavformat -Llibavutil -lavformat -lavcodec -lavutil \
    -o "$BUILD/decoder.js" "$SRC/decoder.c" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_FUNCTIONS="$EXPORTS" \
    -s EXPORTED_RUNTIME_METHODS='["cwrap"]'
}

# the binaryen (wasm-opt) stage of emcc is skipped at -O0; decoder.c is
# still compiled optimized on its own and the FFmpeg libraries are optimized
# already, so only the whole-wasm post-link passes are lost
link_without_binaryen() {
  emcc -O3 -msimd128 -I. -c "$SRC/decoder.c" -o "$BUILD/decoder.o"
  emcc -O0 \
    "$BUILD/decoder.o" \
    -Llibavcodec -Llibavformat -Llibavutil -lavformat -lavcodec -lavutil \
    -o "$BUILD/decoder.js" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_FUNCTIONS="$EXPORTS" \
    -s EXPORTED_RUNTIME_METHODS='["cwrap"]'
}

# verify the exports and the streaming contract of a link result; a link
# can also succeed while producing a wasm that its own glue cannot
# instantiate (a wasm-opt of a different version renames the imports)
verify() {
  if command -v node > /dev/null; then
    node "$SRC/../tests/wasm-smoke.cjs" "$BUILD/decoder.js" > /dev/null 2>&1
  else
    return 0 # without node there is nothing to verify with
  fi
}

rm -f "$BUILD/decoder.js" "$BUILD/decoder.wasm" "$BUILD/decoder.o"
if ! link_full || ! verify; then
  echo "build.sh: the full link failed or its result does not verify (the" >&2
  echo "wasm-opt of this host cannot run on inputs of this size or is of a" >&2
  echo "different version); retrying without the binaryen stage" >&2
  rm -f "$BUILD/decoder.js" "$BUILD/decoder.wasm" "$BUILD/decoder.o"
  link_without_binaryen
fi

popd > /dev/null

ls -la "$BUILD/decoder.js" "$BUILD/decoder.wasm"

# verify the exports and the streaming contract of the final build
if command -v node > /dev/null; then
  node "$SRC/../tests/wasm-smoke.cjs" "$BUILD/decoder.js"
fi

if [ "$COPY" = 1 ]; then
  cp "$BUILD/decoder.js" "$BUILD/decoder.wasm" "$V2/"
  echo "replaced the checked-in binaries in $V2"
  echo "review their size and bump versions.core in v2/data/player/decoder/wrapper.js when the build changed"
fi

echo "BUILD OK"
