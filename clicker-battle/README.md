# Clicker Battle

Two ESP32 buttons over BLE, one native macOS window. 30-second round,
combo multiplier, highest score wins.

No cmake. No Homebrew. No third-party libraries — Cocoa and CoreBluetooth
both ship with macOS, and clang comes with the Xcode command line tools.

## Run it

Double-click **Clicker Battle.app** in Finder, or:

    open "Clicker Battle.app"

Keyboard works alongside the controllers: `a` = player 1, `l` = player 2.
So you can play right now with no hardware at all.

Launch it with `open` or Finder, not by running the inner binary directly —
macOS resolves the app's Bluetooth permission through the bundle.

## Rebuild after editing

    ./build.sh

## Play with the ESP32s

1. Flash `firmware/clicker_esp32/clicker_esp32.ino` to both boards,
   changing

       static const char* kDeviceName = "ESP32-P1";

   to `"ESP32-P2"` on the second one. That string is the only thing
   telling the players apart.

   Button between **D26 and GND** (diagonal legs), no resistor.
   If the sketch overflows flash: **Tools -> Partition Scheme -> Huge APP**.

2. Launch the app. The footer shows live radio state, and each player's
   dot turns green when their board connects.

3. macOS asks for Bluetooth permission on first launch. Grant it — if you
   deny, the game still runs on the keyboard, and you can change your mind
   under System Settings -> Privacy & Security -> Bluetooth.

## How it plays

- Both controllers connected -> press any button to start
- 3-second countdown, then 30 seconds of clicking
- Clicks within 450ms of each other build a combo; multiplier rises to 3.0x
- Press any button on the results screen for a rematch

Tuning lives at the top of `src/game.hpp`.

## Layout

    src/event.hpp        what a click looks like once parsed
    src/queue.hpp        thread-safe handoff, BLE thread -> game loop
    src/game.cpp         scoring, combo, phases — no BLE, no windowing
    src/ble_hub.hpp      backend-agnostic front end (pure C++)
    src/ble_hub_mac.mm   CoreBluetooth backend (Objective-C++)
    src/app_mac.mm       Cocoa window, drawing, keyboard, main()
    Info.plist           bundle metadata + Bluetooth usage description

`src/main.cpp`, `src/render.cpp` and `src/keyboard_input.cpp` are the older
terminal version, still buildable with `./build-demo.sh` -> `./clicker-demo`.

## Note on Info.plist

macOS does not merely *deny* Bluetooth to an app with no usage description
— it SIGABRTs the process the instant CoreBluetooth is touched. The
`NSBluetoothAlwaysUsageDescription` key is mandatory, and `build.sh` also
embeds the plist into the executable with

    -Wl,-sectcreate,__TEXT,__info_plist,Info.plist

so the metadata travels with the binary itself.
