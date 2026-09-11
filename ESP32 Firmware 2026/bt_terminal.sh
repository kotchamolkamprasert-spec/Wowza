#!/usr/bin/env bash
# Bluetooth serial terminal for the ESP32 - macOS / Linux version.
#
#   ./bt_terminal.sh              auto-pick the ESP32 and start listening
#   ./bt_terminal.sh -l           list serial devices
#   ./bt_terminal.sh /dev/cu.XXX  use a specific device
#
# Press Ctrl+C to stop.

BAUD=115200
MATCH="ESP32"

list_ports() {
  ls /dev/cu.* /dev/rfcomm* /dev/ttyUSB* 2>/dev/null | grep -v Bluetooth-Incoming
}

if [ "$1" = "-l" ]; then
  echo "Serial devices:"
  list_ports
  exit 0
fi

PORT="$1"

if [ -z "$PORT" ]; then
  PORT=$(list_ports | grep -i "$MATCH" | head -1)
  if [ -z "$PORT" ]; then
    echo "Could not find a device matching '$MATCH'."
    echo ""
    echo "Devices available right now:"
    list_ports
    echo ""
    echo "Pair the ESP32 first, then re-run. Or pass the device path directly."
    exit 1
  fi
  echo "Found $PORT"
fi

# macOS uses -f, Linux uses -F
if stty -f "$PORT" $BAUD 2>/dev/null; then
  :
elif stty -F "$PORT" $BAUD 2>/dev/null; then
  :
else
  echo "Could not configure $PORT. Is the ESP32 powered on and in range?"
  exit 1
fi

echo "Opening $PORT at $BAUD baud. Ctrl+C to stop."
echo "----------------------------------------"

cat "$PORT" | while IFS= read -r line; do
  printf '[%s] %s\n' "$(date +%H:%M:%S)" "$line"
done
