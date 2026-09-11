#include "BluetoothSerial.h"

BluetoothSerial SerialBT;

int button_1 = 23;
int button_2 = 22;
int press_record = 0;

void setup() {
  Serial.begin(115200);
  pinMode(button_1, INPUT_PULLUP);
  pinMode(button_2, INPUT_PULLUP);

  SerialBT.begin("ESP32_Test");
  Serial.println("Bluetooth is on. Pair with: ESP32_Test");
}

void loop() {
  if (digitalRead(button_1) == LOW) {
    press_record++;
    send_count("Button 1");
    while (digitalRead(button_1) == LOW) {
      delay(10);
    }
    delay(50);
  }

  if (digitalRead(button_2) == LOW) {
    press_record++;
    send_count("Button 2");
    while (digitalRead(button_2) == LOW) {
      delay(10);
    }
    delay(50);
  }

  // Send 'r' from the phone to reset the counter.
  if (SerialBT.available()) {
    char c = SerialBT.read();
    if (c == 'r') {
      press_record = 0;
      SerialBT.println("counter reset");
    }
  }
}

// Print the same line to the USB cable and to the phone.
void send_count(String name) {
  Serial.print(name);
  Serial.print("  total: ");
  Serial.println(press_record);

  SerialBT.print(name);
  SerialBT.print("  total: ");
  SerialBT.println(press_record);
}
