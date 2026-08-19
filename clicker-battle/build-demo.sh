#!/bin/sh
# Builds the keyboard-only version. No cmake, no dependencies -- just clang.
set -e
c++ -std=c++17 -O2 -Isrc -DCLICKER_NO_BLE \
    src/main.cpp src/game.cpp src/render.cpp src/keyboard_input.cpp \
    -o clicker-demo
echo "built ./clicker-demo"
