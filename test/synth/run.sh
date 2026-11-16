#!/bin/sh
# Builds and runs the synth's tests on this computer; the example WAVs land in test/synth/out/.
cd "$(dirname "$0")" || exit 1
python3 ../../tools/embed.py >/dev/null || exit 1
mkdir -p out
c++ -std=c++17 -O2 -Wall -Wno-unused-function -o out/render render.cpp || exit 1
out/render out
