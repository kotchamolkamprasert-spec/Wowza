/* ===========================================================================
 *  >>> THIS IS THE CARNIVAL CLICKER FIRMWARE <<<
 *  Use this one for  Pattadon/carnival-clicker  (the 60-second booth game).
 *  Buttons GPIO 23 and 22.  Autofire OFF.  Sends "CLK 1 <total>".
 *  Change BT_NAME to PotClicker1 on one board and PotClicker2 on the other.
 *
 *  NOT to be confused with clicker-game/firmware/esp32_clicker, which is for
 *  the Pot Mender game and has autofire ON.
 * ======================================================================== */
/*
 * Pot Mender - ESP32 Classic Bluetooth (SPP) clicker controller
 * ------------------------------------------------------------
 * Presents itself as a Bluetooth serial device called "PotClicker".  Pair it
 * once from Windows or macOS and the OS hands the game a virtual COM port /
 * /dev/cu.* device.  Everything below also works over the USB cable, because
 * every line is mirrored to the USB serial port too.
 *
 * Board:  any original ESP32 (WROOM/WROVER).  ESP32-S2/S3/C3 do NOT have
 *         Classic Bluetooth - they only do BLE - so they will not work here.
 *
 * Wiring (all pins configurable below):
 *   GPIO23 -- push button -- GND      main click button
 *   GPIO22 -- push button -- GND      second button, also counts as a click
 *   GPIO2  -- onboard LED             feedback (already fitted on most devkits)
 *   GPIO25 -- passive buzzer -- GND   optional click sound
 *
 * Protocol, one ASCII line per message.
 *   out:  HELLO PotClicker v1.0 proto=1
 *         CLK <n>      a click happened
 *         BTN <0|1>    button released / pressed
 *         ALT 1        second button pressed
 *         HB <ms> <n>  heartbeat, uptime in milliseconds and total clicks
 *         PONG         answer to PING
 *         ACK <cmd>    command accepted
 *   in:   PING | ID?           handshake
 *         LED <r> <g> <b>      set the indicator colour
 *         BUZZ <freq> <ms>     make a noise
 *         LVL <n>              current pot number, drives LED brightness
 *         MEND                 celebration
 *         BUY                  purchase confirmation blip
 *         BYE                  the game is closing
 */

#include <Arduino.h>

// Check the board FIRST, before including anything Bluetooth.  On an S2/S3/C3
// the Classic Bluetooth headers do not exist at all, so including them would
// fail with "no such file" and bury the real reason.
#if !defined(CONFIG_BT_ENABLED) || !defined(CONFIG_BLUEDROID_ENABLED)
#error "Classic Bluetooth is off. Select an original ESP32 board (not S2/S3/C3)."
#endif
#if !defined(CONFIG_BT_SPP_ENABLED)
#error "Bluetooth SPP is not enabled in this build of the ESP32 core."
#endif

#include "BluetoothSerial.h"
#include "esp_system.h"        // esp_reset_reason

// Guarded the same way BluetoothSerial.h guards itself.  On a chip without
// Classic Bluetooth these headers are simply absent, and a "no such file"
// further down would distract from the #error above, which is the real answer.
#if defined(CONFIG_BT_SPP_ENABLED)
#include "esp_bt.h"            // esp_bt_sleep_disable
#include "esp_gap_bt_api.h"    // esp_bt_gap_set_scan_mode
#endif

// ------------------------------------------------------------------ config
// ---------------------------------------------------------------------------
// CHANGE THIS ONE LINE PER BOARD, then flash.  The trailing number decides who
// is player 1 and who is player 2 - the game reads it from the name, so the
// same physical box is always the same player.
//   board A -> "PotClicker1"      board B -> "PotClicker2"
#define BT_NAME        "PotClicker1"
// ---------------------------------------------------------------------------
#define FW_VERSION     "1.1"

#define PIN_BTN_MAIN   23   // matches the BT_Buttons wiring
#define PIN_BTN_ALT    22   // matches the BT_Buttons wiring
#define PIN_LED        2
#define PIN_BUZZER     25

#define USE_BUZZER     1      // set to 0 if nothing is wired to PIN_BUZZER
#define USE_NEOPIXEL   0      // set to 1 for a WS2812 on PIN_NEOPIXEL
#define PIN_NEOPIXEL   4

#define DEBOUNCE_MS        8
#define HOLD_START_MS      450    // autofire thresholds, unused at the booth
#define HOLD_INTERVAL_MS   55     // (see the note in loop about fairness)
#define HEARTBEAT_MS       2000

#if USE_NEOPIXEL
#include <Adafruit_NeoPixel.h>
Adafruit_NeoPixel pixel(1, PIN_NEOPIXEL, NEO_GRB + NEO_KHZ800);
#endif

BluetoothSerial SerialBT;

// The LEDC API changed shape in Arduino-ESP32 core 3.x, so support both.
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  #define LEDC_NEW_API 1
#else
  #define LEDC_NEW_API 0
#endif
#define LEDC_CH_LED   0
#define LEDC_CH_BUZZ  1

// ------------------------------------------------------------------ buttons
// Declared up here on purpose.  The Arduino preprocessor hoists generated
// function prototypes to just above the first function definition, so any type
// used in a signature has to be visible before that point.
struct Button {
  uint8_t  pin;
  bool     pressed;      // debounced state
  bool     lastRead;
  uint32_t lastChange;
  uint32_t pressedAt;
  uint32_t nextRepeat;
};

static Button btnMain = { PIN_BTN_MAIN, false, false, 0, 0, 0 };
static Button btnAlt  = { PIN_BTN_ALT,  false, false, 0, 0, 0 };

// ------------------------------------------------------------------ state
// These three are written by btEvent(), which does NOT run in loop() - it runs
// on the Bluetooth stack task.  "volatile" stops the compiler caching them in a
// register and never noticing the other task changed them.
static volatile bool linked      = false;   // a Bluetooth client is attached
static volatile bool btOpened    = false;   // a client just arrived
static volatile bool btClosed    = false;   // a client just went away

static uint32_t txStallUntil  = 0;       // radio is backed up until this millis
static uint32_t lastHeartbeat = 0;
static uint32_t buzzUntil     = 0;
static uint32_t clickCount    = 0;
static uint8_t  potLevel      = 1;
static float    ledFlash      = 0.0f;    // 0..1, decays after every click
static uint8_t  ledR = 255, ledG = 190, ledB = 90;
static uint32_t lastFrame     = 0;

// ------------------------------------------------------------------ output
// Sending over Bluetooth is not free and it is not instant.  Underneath,
// SerialBT hands the text to a 32 slot driver queue and waits up to a whole
// second for a free slot.  So if the PC stops collecting - it got busy, it
// wandered out of range, the link is half dead - every send parks loop() for
// up to a second, buttons stop being read and the LED freezes.
//
// Two defences.  We push each line as ONE packet instead of letting println()
// queue the text and the newline separately, and we time the send: if it took
// real time then the queue was full, so for a short while afterwards we skip
// the lines we can afford to lose.  Clicks and heartbeats are "optional" in
// that sense; handshake replies never are.
static void sendLineEx(const char *line, bool optional) {
  Serial.println(line);              // the USB mirror always gets everything
  if (!linked) return;

  uint32_t now = millis();
  if (optional && txStallUntil && (int32_t)(now - txStallUntil) < 0) return;

  char pkt[80];
  size_t n = strlen(line);
  if (n > sizeof(pkt) - 3) n = sizeof(pkt) - 3;
  memcpy(pkt, line, n);
  pkt[n++] = '\r';
  pkt[n++] = '\n';
  SerialBT.write((const uint8_t *)pkt, n);

  // A healthy send returns in well under a millisecond.
  if (millis() - now >= 20) {
    txStallUntil = millis() + 400;
  } else {
    txStallUntil = 0;
  }
}

static void sendLine(const char *line) {
  sendLineEx(line, false);
}

static void sendHello() {
  char buf[64];
  snprintf(buf, sizeof(buf), "HELLO %s v%s proto=1", BT_NAME, FW_VERSION);
  sendLine(buf);
}

// ------------------------------------------------------------------ led
static void ledInit() {
#if LEDC_NEW_API
  ledcAttach(PIN_LED, 5000, 8);
#else
  ledcSetup(LEDC_CH_LED, 5000, 8);
  ledcAttachPin(PIN_LED, LEDC_CH_LED);
#endif
#if USE_NEOPIXEL
  pixel.begin();
  pixel.setBrightness(90);
  pixel.show();
#endif
}

static void ledOut(uint8_t duty) {
#if LEDC_NEW_API
  ledcWrite(PIN_LED, duty);
#else
  ledcWrite(LEDC_CH_LED, duty);
#endif
#if USE_NEOPIXEL
  float k = duty / 255.0f;
  pixel.setPixelColor(0, pixel.Color((uint8_t)(ledR * k), (uint8_t)(ledG * k),
                                     (uint8_t)(ledB * k)));
  pixel.show();
#endif
}

// ------------------------------------------------------------------ buzzer
static void buzzInit() {
#if USE_BUZZER
#if LEDC_NEW_API
  ledcAttach(PIN_BUZZER, 2000, 10);
#else
  ledcSetup(LEDC_CH_BUZZ, 2000, 10);
  ledcAttachPin(PIN_BUZZER, LEDC_CH_BUZZ);
#endif
#endif
}

static void buzzTone(uint16_t freq, uint16_t ms) {
#if USE_BUZZER
#if LEDC_NEW_API
  ledcWriteTone(PIN_BUZZER, freq);
#else
  ledcWriteTone(LEDC_CH_BUZZ, freq);
#endif
  buzzUntil = millis() + ms;
#else
  (void)freq; (void)ms;
#endif
}

static void buzzStop() {
#if USE_BUZZER
#if LEDC_NEW_API
  ledcWriteTone(PIN_BUZZER, 0);
#else
  ledcWriteTone(LEDC_CH_BUZZ, 0);
#endif
#endif
  buzzUntil = 0;
}

static void buttonInit(Button &b) {
  pinMode(b.pin, INPUT_PULLUP);
  b.lastRead = false;
  b.pressed  = false;
}

// Returns +1 on a fresh press, -1 on release, 2 on an autofire repeat, else 0.
static int buttonPoll(Button &b, uint32_t now, bool autofire) {
  bool raw = (digitalRead(b.pin) == LOW);      // buttons pull the pin to GND
  if (raw != b.lastRead) {
    b.lastRead = raw;
    b.lastChange = now;
  }
  if (raw != b.pressed && (now - b.lastChange) >= DEBOUNCE_MS) {
    b.pressed = raw;
    if (b.pressed) {
      b.pressedAt = now;
      b.nextRepeat = now + HOLD_START_MS;
      return 1;
    }
    return -1;
  }
  if (autofire && b.pressed && now >= b.nextRepeat) {
    b.nextRepeat = now + HOLD_INTERVAL_MS;
    return 2;
  }
  return 0;
}

// ------------------------------------------------------------------ events
static void onClick(bool fromHold) {
  char buf[24];
  clickCount++;
  // The running total rides along with every click.  Marked optional so a
  // congested radio drops a packet instead of stalling the sketch - and
  // because the total is in the message, the PC can tell it missed one and
  // make up the difference rather than scoring somebody short.
  snprintf(buf, sizeof(buf), "CLK 1 %lu", (unsigned long)clickCount);
  sendLineEx(buf, true);
  ledFlash = 1.0f;
  buzzTone(fromHold ? 1900 : 2400, fromHold ? 6 : 12);
}

static void celebrate() {
  ledFlash = 1.0f;
  buzzTone(1568, 70);
}

// ------------------------------------------------------------------ commands
static void handleCommand(char *line) {
  if (!line[0]) return;

  if (!strncmp(line, "PING", 4)) {
    sendLine("PONG");
  } else if (!strncmp(line, "ID?", 3)) {
    sendHello();
  } else if (!strncmp(line, "LED", 3)) {
    int r = 255, g = 190, b = 90;
    if (sscanf(line + 3, "%d %d %d", &r, &g, &b) >= 1) {
      ledR = (uint8_t)constrain(r, 0, 255);
      ledG = (uint8_t)constrain(g, 0, 255);
      ledB = (uint8_t)constrain(b, 0, 255);
    }
    sendLine("ACK LED");
  } else if (!strncmp(line, "BUZZ", 4)) {
    int f = 2200, ms = 40;
    sscanf(line + 4, "%d %d", &f, &ms);
    buzzTone((uint16_t)constrain(f, 60, 8000), (uint16_t)constrain(ms, 1, 1500));
    sendLine("ACK BUZZ");
  } else if (!strncmp(line, "LVL", 3)) {
    int n = 1;
    if (sscanf(line + 3, "%d", &n) == 1) {
      potLevel = (uint8_t)constrain(n, 1, 255);
    }
    sendLine("ACK LVL");
  } else if (!strncmp(line, "MEND", 4)) {
    celebrate();
    sendLine("ACK MEND");
  } else if (!strncmp(line, "BUY", 3)) {
    buzzTone(2600, 25);
    sendLine("ACK BUY");
  } else if (!strncmp(line, "BYE", 3)) {
    sendLine("ACK BYE");
  }
}

// Collects bytes until a newline, then runs the command.  Two guards here.
//
// An overlong line is thrown away whole.  It used to be truncated at 63 bytes
// and then obeyed, which meant a burst of noise starting with the right couple
// of letters could fire a real command.
//
// And we stop after a fixed number of bytes per call.  Commands can answer
// with an ACK, so a flood of junk would otherwise turn into a flood of replies
// and hold up the buttons and the heartbeat.  Whatever is left simply waits in
// the driver buffer for the next pass, two milliseconds later.
static void feed(Stream &stream, char *buf, uint8_t &len, bool &overflow,
                 uint8_t cap) {
  uint16_t budget = 128;
  while (budget-- && stream.available()) {
    char c = (char)stream.read();
    if (c == '\n' || c == '\r') {
      if (overflow) {
        overflow = false;      // the line was too long, so bin all of it
        len = 0;
      } else if (len) {
        buf[len] = 0;
        handleCommand(buf);
        len = 0;
      }
    } else if (len < cap - 1) {
      buf[len++] = c;
    } else {
      overflow = true;         // full: keep eating until the newline arrives
    }
  }
}

// ------------------------------------------------------------------ bt
// Careful: this does NOT run in loop().  The Bluetooth stack calls it on its
// own task, so the only safe thing to do here is set a flag and get out.
//
// It used to print, beep and send the HELLO from right here.  Sending is the
// dangerous one: a Bluetooth write waits for the stack task to acknowledge the
// previous packet, and the stack task is the one stuck inside this function -
// so the two can sit waiting for each other and the radio locks up.
static void btEvent(esp_spp_cb_event_t event, esp_spp_cb_param_t *param) {
  (void)param;
  if (event == ESP_SPP_SRV_OPEN_EVT) {
    linked  = true;
    btOpened = true;
  } else if (event == ESP_SPP_CLOSE_EVT) {
    linked  = false;
    btClosed = true;
  }
}

// ------------------------------------------------------------------ arduino
void setup() {
  Serial.begin(115200);
  delay(80);

  buttonInit(btnMain);
  buttonInit(btnAlt);
  ledInit();
  buzzInit();

  SerialBT.register_callback(btEvent);
  SerialBT.begin(BT_NAME);

  // Keep the radio awake.  Bluetooth modem sleep saves a couple of milliamps
  // and costs reliability - it shows up as stalls and dropped links.
  esp_bt_sleep_disable();

  // Ask for the strongest transmit power the radio allows.  A hall full of
  // phones and hotspots is a hostile 2.4 GHz environment; Classic Bluetooth
  // already hops away from busy channels by itself, this buys margin on top.
  esp_bredr_tx_power_set(ESP_PWR_LVL_P9, ESP_PWR_LVL_P9);

  // Make sure we really are visible and connectable.  The Bluetooth library
  // sets this once when SPP starts and never puts it back afterwards.
  esp_bt_gap_set_scan_mode(ESP_BT_CONNECTABLE, ESP_BT_GENERAL_DISCOVERABLE);

  lastFrame = millis();
  Serial.println();
  sendHello();
  Serial.print("Pair this device as: ");
  Serial.println(BT_NAME);

  // Why did we just boot?  A board that reboots on its own is almost always
  // being starved of power: a thin USB cable, an unpowered hub or a long
  // extension cannot always feed the current spike the radio pulls when it
  // transmits.  Say so plainly, because from the PC side it looks identical
  // to a Bluetooth fault.  This is a wiring problem, not a firmware one.
  if (esp_reset_reason() == ESP_RST_BROWNOUT) {
    Serial.println("WARN brownout reset - power is dipping. Try a shorter or "
                   "thicker USB cable, or a powered port.");
  }

  // little startup arpeggio so you know it booted
  buzzTone(880, 60);
}

void loop() {
  uint32_t now = millis();
  float dt = (now - lastFrame) / 1000.0f;
  if (dt < 0.0f || dt > 0.5f) dt = 0.016f;
  lastFrame = now;

  // ---- input ----------------------------------------------------------
  // Autofire is OFF on purpose.  This is a competition: if holding the button
  // produced 18 clicks a second, the first person to work that out would own
  // the leaderboard and everybody else would be playing a different game.
  // One press, one click, both buttons - so two hands are allowed but a
  // jammed button cannot run away with it.
  int main_ev = buttonPoll(btnMain, now, false);
  if (main_ev == 1) {
    sendLine("BTN 1");
    onClick(false);
  } else if (main_ev == -1) {
    sendLine("BTN 0");
  }

  if (buttonPoll(btnAlt, now, false) == 1) {
    onClick(false);
  }

  // ---- commands from the game -----------------------------------------
  static char btBuf[64];
  static uint8_t btLen = 0;
  static bool btOvf = false;
  static char usbBuf[64];
  static uint8_t usbLen = 0;
  static bool usbOvf = false;

  // "linked" has exactly one writer now, the callback above.  This used to
  // also poll SerialBT.hasClient() on every pass and overwrite it, so the two
  // fought: the callback would say connected and the very next line of loop()
  // could set it straight back to disconnected, and the HELLO went nowhere.
  //
  // Closed is handled before opened, so that if a client drops and a new one
  // arrives within the same couple of milliseconds we still end up connected.
  if (btClosed) {
    btClosed = false;
    btLen = 0; btOvf = false;      // half a command from the old peer is junk
    txStallUntil = 0;
    // Start advertising again.  The library sets the scan mode once, when SPP
    // first starts, and does not restore it when a client disconnects - which
    // on some builds leaves the board invisible until it is power cycled.
    esp_bt_gap_set_scan_mode(ESP_BT_CONNECTABLE, ESP_BT_GENERAL_DISCOVERABLE);
  }
  if (btOpened) {
    btOpened = false;
    btLen = 0; btOvf = false;
    txStallUntil = 0;
    // The greeting, the beep and the flash live here rather than in the
    // callback, because here it is safe to send.
    buzzTone(1046, 40);
    ledFlash = 1.0f;
    sendHello();
  }

  if (linked) {
    feed(SerialBT, btBuf, btLen, btOvf, sizeof(btBuf));
  }
  feed(Serial, usbBuf, usbLen, usbOvf, sizeof(usbBuf));

  // ---- feedback --------------------------------------------------------
  if (buzzUntil && now >= buzzUntil) {
    buzzStop();
  }

  ledFlash -= dt * 3.2f;
  if (ledFlash < 0.0f) ledFlash = 0.0f;

  // idle level: a slow breath when linked, a faster blink while waiting
  float phase = (now % (linked ? 2600u : 900u)) / (linked ? 2600.0f : 900.0f);
  float breathe = 0.5f - 0.5f * cosf(phase * 6.2831853f);
  // the further along the garden is, the warmer the idle glow
  float levelGlow = potLevel > 40 ? 0.16f : potLevel * 0.004f;
  float base = linked ? (0.05f + 0.10f * breathe + levelGlow)
                     : (0.02f + 0.35f * breathe);
  float level = base + ledFlash * 0.9f;
  if (level > 1.0f) level = 1.0f;
  ledOut((uint8_t)(level * 255.0f));

  // ---- heartbeat -------------------------------------------------------
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    char buf[32];
    snprintf(buf, sizeof(buf), "HB %lu %lu", (unsigned long)now,
             (unsigned long)clickCount);
    sendLineEx(buf, true);
  }

  // Two milliseconds of doing nothing, on purpose.  delay() hands the CPU to
  // the Bluetooth stack and to the idle task that pets the watchdog, so this
  // is what keeps the radio serviced.  Do not replace it with a busy wait, and
  // keep anything slow out of loop().
  delay(2);
}
