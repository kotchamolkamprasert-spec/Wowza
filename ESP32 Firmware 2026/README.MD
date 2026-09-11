Instruction set for firmware installation


**On Windows:**

1. Install CH340 driver (if COM port doesn't appear)
2. Arduino IDE → File → Preferences → Additional Boards URL: `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
3. Boards Manager → install `esp32` by Espressif
4. Tools → Board → ESP32 Dev Module
5. Tools → Partition Scheme → Huge APP (3MB No OTA)
6. Plug in ESP32 via USB
7. Tools → Port → COM13
8. Open `BT_Buttons/BT_Buttons.ino`
9. Upload
10. Tools → Serial Monitor → 115200 → confirm `Bluetooth is on. Pair with: ESP32_Test`
11. Settings → Bluetooth & devices → Add device → Bluetooth → `ESP32_Test`
12. Close Serial Monitor
13. Run:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\tundr\Documents\Pattadon\ESP32-TEST\bt_terminal.ps1"
```

14. Press buttons
15. Exit: Ctrl-C



**On Mac:**

1. Copy `ESP32-TEST` folder to the Mac
2. Arduino IDE → Preferences → Additional Boards URL: `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
3. Boards Manager → install `esp32` by Espressif
4. Tools → Board → ESP32 Dev Module
5. Tools → Partition Scheme → Huge APP (3MB No OTA)
6. Plug in ESP32 via USB
7. Tools → Port → `/dev/cu.usbserial-*` or `/dev/cu.wchusbserial*`
8. Open `BT_Buttons/BT_Buttons.ino`
9. Upload
10. Tools → Serial Monitor → 115200 → confirm `Bluetooth is on. Pair with: ESP32_Test`
11. System Settings → Bluetooth → pair `ESP32_Test`
12. Terminal: `ls /dev/cu.*`
13. Terminal: `screen /dev/cu.ESP32_Test 115200`
14. Press buttons
15. Exit: Ctrl-A, K, y