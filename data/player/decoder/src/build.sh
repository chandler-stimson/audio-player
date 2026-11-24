#! /bin/bash
# Builds the FFmpeg-based wasm decoder (decoder.js + decoder.wasm) from
# src/decoder.c. Derived from https://github.com/chandler-stimson/decoder.js
#
# Changes over the original build:
#   * -O3 instead of -Oz (decode speed over bundle size)
#   * -msimd128 (clang auto-vectorizes the PCM conversion loops)
#   * exports the incremental streaming API next to the batch entry point
#
# Requirements: emsdk (emconfigure, emmake, emcc), git, make, pkg-config

set -e

apt-get update
apt-get install -y pkg-config

# git clone --depth 1 --branch n4.0.2 https://github.com/FFmpeg/FFmpeg
git clone --depth 1 https://github.com/FFmpeg/FFmpeg

pushd FFmpeg

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

emmake make -j4

emcc -O3 \
  -msimd128 \
  -I. \
  -Llibavcodec -Llibavformat -Llibavutil -lavformat -lavcodec -lavutil \
  -o ../decoder.js ../decoder.c \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s EXPORTED_FUNCTIONS='["_decoder", "_decoder_open", "_decoder_pull", "_decoder_seek", "_decoder_close"]' \
  -s EXPORTED_RUNTIME_METHODS='["cwrap"]'

popd
