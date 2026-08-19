// Clicker Battle controller firmware.
//
// Flash this to BOTH boards. Change kDeviceName to "ESP32-P2" on the second
// one — that string is the only thing distinguishing the players, since the
// laptop matches on advertised name.

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

static const char* kDeviceName = "ESP32-P1";   // <-- "ESP32-P2" on the other board

#define SERVICE_UUID "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
#define RX_UUID      "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
#define TX_UUID      "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"

const int BUTTON_PIN = 4;
const int LED_PIN    = 2;

// Deliberately short. A clicker rewards fast input, and a 50ms window caps
// you at 20 clicks/sec anyway. Drop to 5 if your switch is clean.
const unsigned long DEBOUNCE_MS = 12;

BLEServer         *pServer = nullptr;
BLECharacteristic *pTx     = nullptr;
bool connected = false;

int           lastState  = HIGH;
unsigned long lastChange = 0;
unsigned long pressCount = 0;

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *s) override {
    connected = true;
    digitalWrite(LED_PIN, HIGH);
    Serial.println("connected");
  }
  void onDisconnect(BLEServer *s) override {
    connected = false;
    digitalWrite(LED_PIN, LOW);
    Serial.println("disconnected, re-advertising");
    s->getAdvertising()->start();   // without this the board never reappears
  }
};

void send(const String &msg) {
  if (!connected || !pTx) return;
  pTx->setValue((uint8_t *)msg.c_str(), msg.length());
  pTx->notify();
}

void setup() {
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);

  BLEDevice::init(kDeviceName);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  pTx = pService->createCharacteristic(TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  pTx->addDescriptor(new BLE2902());   // core 3.x adds the CCCD itself
#endif

  pService->start();

  BLEAdvertising *adv = pServer->getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->setScanResponse(true);
  adv->start();

  Serial.printf("advertising as %s\n", kDeviceName);
}

void loop() {
  int state = digitalRead(BUTTON_PIN);

  if (state != lastState && millis() - lastChange > DEBOUNCE_MS) {
    lastChange = millis();
    lastState  = state;

    if (state == LOW) {
      pressCount++;
      send("press " + String(pressCount));   // counter lets the laptop spot dropped packets
    } else {
      send("release");
    }
  }
}
