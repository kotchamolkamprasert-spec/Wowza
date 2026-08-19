#!/bin/sh
# Builds "Clicker Battle.app". No cmake, no Homebrew, no third-party
# libraries: Cocoa and CoreBluetooth both ship with macOS.
set -e

APP="Clicker Battle.app"
CXXFLAGS="-std=c++17 -O2 -Isrc -Wall"
mkdir -p build

echo "compiling..."
c++ $CXXFLAGS            -c src/game.cpp        -o build/game.o
c++ $CXXFLAGS -fobjc-arc -c src/ble_hub_mac.mm  -o build/ble_hub_mac.o
c++ $CXXFLAGS -fobjc-arc -c src/app_mac.mm      -o build/app_mac.o

echo "bundling..."
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"

# -sectcreate embeds Info.plist INSIDE the executable. The copy in
# Contents/ is only consulted for bundle launches; TCC reads the embedded
# section, so this is what stops the Bluetooth SIGABRT when the binary is
# run directly from a terminal.
c++ build/game.o build/ble_hub_mac.o build/app_mac.o \
    -framework Cocoa -framework CoreBluetooth \
    -Wl,-sectcreate,__TEXT,__info_plist,Info.plist \
    -o "$APP/Contents/MacOS/clicker"

# Ad-hoc signature. Not for distribution -- it gives the bundle a stable
# identity so macOS remembers the Bluetooth permission between rebuilds
# instead of re-prompting every time.
if command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - "$APP" >/dev/null 2>&1 && echo "signed (ad-hoc)"
fi

echo "built $APP"
