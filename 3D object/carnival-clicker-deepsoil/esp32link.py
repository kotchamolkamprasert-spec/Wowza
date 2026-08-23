"""Serial link to one or more ESP32 Classic Bluetooth clicker boards.

Same approach as the Pot Mender link: a paired SPP device shows up as a plain
virtual serial port, so we speak pyserial and never touch a platform Bluetooth
stack.  Two rules carried over, both learned the hard way:

* Opening a port is not a passive act.  On Windows, opening a Bluetooth COM
  port makes the OS dial that device, so a scan that opens everything will yank
  the user headphones onto a serial channel.  We only open ports we have a
  positive reason to believe are ours.
* A port that does not answer gets retried on a doubling delay, so we never sit
  on a serial port something else wants.
"""

from __future__ import annotations

import queue
import re
import sys
import threading
import time

try:
    import serial
    from serial.tools import list_ports
    HAVE_SERIAL = True
except Exception:
    serial = None
    list_ports = None
    HAVE_SERIAL = False

BAUD = 115200

#: Bluetooth names we accept as a controller, matched with separators stripped.
#: ESP32_Client1..4 are the existing BT_Buttons boards; potclicker is the newer
#: firmware.  A trailing digit picks the player slot, so player 1 is always the
#: same physical box.
CONTROLLER_NAMES = ("potclicker", "esp32client", "esp32test")
NAME_HINTS = ("potclicker", "pot-clicker", "clicker", "esp32_client")
PORT_BLOCKLIST = ("bluetooth-incoming-port", "debug-console", "wlan-debug")
USB_HINTS = ("cp210", "ch340", "ch910", "silicon labs", "usb serial",
             "wch", "ftdi", "usb-serial", "usbserial")
PROBE_TIMEOUT = 1.6
RECONNECT_DELAY = 2.0
MAX_BACKOFF = 60.0

_MAC_IN_HWID = re.compile(r"&([0-9A-F]{12})_C", re.I)
_BT_DEV_KEY = re.compile(r"^DEV_([0-9A-F]{12})$", re.I)
_names_cache = None


def windows_bt_names(refresh=False):
    """Bluetooth MAC -> paired device name, straight out of the registry.

    pyserial shows every Windows Bluetooth port as the same anonymous string,
    so this is the only way to tell a controller from a pair of headphones.
    Best effort - on failure we simply have less to go on.
    """
    global _names_cache
    if _names_cache is not None and not refresh:
        return _names_cache
    names = {}
    if sys.platform.startswith("win"):
        try:
            import winreg
            branch = r"SYSTEM\CurrentControlSet\Enum\BTHENUM"
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, branch) as root:
                for i in range(4096):
                    try:
                        sub = winreg.EnumKey(root, i)
                    except OSError:
                        break
                    hit = _BT_DEV_KEY.match(sub)
                    if not hit:
                        continue
                    mac = hit.group(1).upper()
                    try:
                        with winreg.OpenKey(root, sub) as dev:
                            for j in range(64):
                                try:
                                    inst = winreg.EnumKey(dev, j)
                                except OSError:
                                    break
                                try:
                                    with winreg.OpenKey(dev, inst) as key:
                                        names[mac] = winreg.QueryValueEx(
                                            key, "FriendlyName")[0]
                                except OSError:
                                    pass
                    except OSError:
                        pass
        except Exception:
            names = {}
    _names_cache = names
    return names


def device_name(port):
    mac = _MAC_IN_HWID.search(port.hwid or "")
    if not mac:
        return None
    return windows_bt_names().get(mac.group(1).upper())


def classify(port):
    """(score, allowed, reason) for one serial port."""
    dev = port.device or ""
    friendly = device_name(port)
    low = " ".join((dev, port.description or "", port.hwid or "",
                    friendly or "")).lower()
    flat = low.replace("_", "").replace("-", "").replace(" ", "")

    if any(b in dev.lower() for b in PORT_BLOCKLIST):
        return 0, False, "blocked (opening it hangs)"
    if sys.platform == "darwin" and dev.startswith("/dev/tty."):
        return 0, False, "use the cu. twin"

    named = any(c in flat for c in CONTROLLER_NAMES)
    hinted = named or any(h in low for h in NAME_HINTS)
    is_bt = "bthenum" in low or "bluetooth" in low
    has_mac = bool(_MAC_IN_HWID.search(port.hwid or ""))
    is_usb = any(h in low for h in USB_HINTS)

    score = 20 if named else (10 if hinted else 0)
    if is_bt:
        score += 4 + (2 if has_mac else -6)
    if is_usb:
        score += 3

    if named:
        return score, True, "advertises the controller name"
    if not is_bt:
        return score, True, "wired serial port"
    if is_bt and not has_mac:
        return score, False, "unused Bluetooth slot"
    if friendly:
        return score, False, "paired device: %s" % friendly
    if windows_bt_names():
        return score, False, "unidentified Bluetooth device"
    return score, True, "unidentified (no name lookup)"


def is_controller_name(name):
    """True if this Bluetooth device name is one of our controllers."""
    if not name:
        return False
    flat = name.lower().replace("_", "").replace("-", "").replace(" ", "")
    return any(c in flat for c in CONTROLLER_NAMES)


def slot_from_name(name):
    """ESP32_Client2 -> 2.  None if the name carries no number."""
    if not name:
        return None
    digits = "".join(ch for ch in name if ch.isdigit())
    return int(digits[-1]) if digits else None


def survey():
    """Every port with our verdict on it, for diagnostics."""
    if not HAVE_SERIAL:
        return []
    out, seen = [], set()
    for p in list_ports.comports():
        if p.device in seen:
            continue
        seen.add(p.device)
        score, allowed, reason = classify(p)
        out.append({"port": p.device, "device": device_name(p),
                    "allowed": allowed, "reason": reason, "score": score,
                    "named": is_controller_name(device_name(p))})
    out.sort(key=lambda r: -r["score"])
    return out


def candidates(probe_all=False):
    return [r["port"] for r in survey() if r["allowed"] or probe_all]


def open_port(dev):
    """Open without asserting DTR/RTS, which would reset a USB-attached ESP32."""
    ser = serial.Serial()
    ser.port = dev
    ser.baudrate = BAUD
    ser.timeout = 0.25
    ser.write_timeout = 1.5
    ser.dtr = False
    ser.rts = False
    ser.open()
    try:
        ser.reset_input_buffer()
    except Exception:
        pass
    return ser


class Board:
    """One connected controller, with its own reader thread."""

    def __init__(self, slot, dev, ser, events, on_drop, expect_replies=True):
        self.slot = slot
        self.dev = dev
        self.ser = ser
        self.events = events
        self.on_drop = on_drop
        # BT_Buttons boards say nothing at all until somebody presses a button
        # and ignore PING, so a silence timeout would drop a perfectly healthy
        # board while the attract screen is up.  Only boards that answer a
        # handshake get held to one.
        self.expect_replies = expect_replies
        self.last_total = None      # running click count reported by the board
        self.alive = True
        self.last_rx = time.time()
        self._out = queue.Queue()
        self.thread = threading.Thread(target=self._pump, daemon=True,
                                       name="board%d" % slot)
        self.thread.start()

    def send(self, line):
        self._out.put(line)

    def close(self):
        self.alive = False

    def _pump(self):
        last_ping = time.time()
        try:
            while self.alive:
                while True:
                    try:
                        cmd = self._out.get_nowait()
                    except queue.Empty:
                        break
                    self.ser.write((cmd.rstrip() + "\n").encode("ascii", "ignore"))

                raw = self.ser.readline()
                now = time.time()
                if raw:
                    self.last_rx = now
                    line = raw.decode("utf-8", "ignore").strip()
                    if line:
                        self._parse(line)
                else:
                    if now - last_ping > 4.0:
                        last_ping = now
                        self.ser.write(b"PING\n")
                    if self.expect_replies and now - self.last_rx > 12.0:
                        break
        except Exception:
            pass
        finally:
            self.alive = False
            try:
                self.ser.close()
            except Exception:
                pass
            self.on_drop(self)

    def _parse(self, line):
        """Understand both controller firmwares.

        BT_Buttons boards send a human sentence per press:
            Button 1  total: 5
        The newer PotClicker firmware sends terse tokens:
            CLK 1
        Either way one line means one click.  We count clicks ourselves rather
        than trusting the board total, so a reconnect mid-round cannot rewind
        anybody score.
        """
        parts = line.split()
        head = parts[0].upper()
        if head in ("CLK", "HOLD", "BUTTON"):
            self.events.put({"type": "click", "player": self.slot})
            self._check_gap(parts)
        elif head == "BTN":
            down = line.split()[1:2] not in ([], ["0"])
            self.events.put({"type": "button", "player": self.slot, "down": down})
        elif head == "ALT":
            self.events.put({"type": "alt", "player": self.slot})

    def _check_gap(self, parts):
        """Make up clicks the radio swallowed.

        Both firmwares put a running total in the click line - "CLK 1 42" and
        "Button 1  total: 42".  If the total jumps by more than one, packets
        were lost in the air, so we emit the difference.  Without this a burst
        of interference quietly scores somebody short mid-round, which is the
        one thing a competition cannot tolerate.
        """
        try:
            total = int(parts[-1])
        except (ValueError, IndexError):
            return
        prev, self.last_total = self.last_total, total
        if prev is None or total <= prev:
            return                       # first line, or the board restarted
        missed = min(total - prev - 1, 25)
        for _ in range(max(0, missed)):
            self.events.put({"type": "click", "player": self.slot, "recovered": True})


class ControllerHub:
    """Finds up to `slots` boards and keeps them connected.

    Slot assignment: if a board advertises a name ending in a digit
    (PotClicker1 / PotClicker2) that digit picks the slot, so player 1 is
    always the same physical box.  Otherwise boards fill slots in the order
    they connect.
    """

    def __init__(self, slots=2, probe_all=False, forced=None):
        self.slots = slots
        self.probe_all = probe_all
        self.forced = list(forced or [])
        self.events = queue.Queue()
        self.boards = {}                 # slot -> Board
        self._backoff = {}               # device -> (failures, not before)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None

    # ---------------------------------------------------------------- api
    def start(self):
        if not HAVE_SERIAL or self._thread:
            return
        self._thread = threading.Thread(target=self._run, daemon=True,
                                        name="hub")
        self._thread.start()

    def stop(self):
        self._stop.set()
        for b in list(self.boards.values()):
            b.close()

    def rescan(self):
        self._backoff.clear()

    def status(self):
        with self._lock:
            return {
                "available": HAVE_SERIAL,
                "enabled": True,
                "slots": self.slots,
                "connected": {str(s): b.dev for s, b in self.boards.items()},
            }

    def send(self, slot, line):
        b = self.boards.get(slot)
        if b:
            b.send(line)

    def broadcast(self, line):
        for b in list(self.boards.values()):
            b.send(line)

    def drain(self):
        out = []
        while True:
            try:
                out.append(self.events.get_nowait())
            except queue.Empty:
                return out

    # ------------------------------------------------------------- thread
    def _drop(self, board):
        with self._lock:
            if self.boards.get(board.slot) is board:
                del self.boards[board.slot]
        # A controller that was working a second ago is worth retrying at once.
        # Backoff exists to stop us pestering ports that are not ours, not to
        # punish a board that just walked behind somebody head.
        self._backoff.pop(board.dev, None)
        self.events.put({"type": "disconnect", "player": board.slot,
                         "port": board.dev})

    def _free_slot(self, hinted):
        with self._lock:
            if hinted and hinted not in self.boards:
                return hinted
            for s in range(1, self.slots + 1):
                if s not in self.boards:
                    return s
        return None

    def _run(self):
        while not self._stop.is_set():
            with self._lock:
                busy = {b.dev for b in self.boards.values()}
                full = len(self.boards) >= self.slots
            if full:
                self._stop.wait(1.0)
                continue

            rows = survey()
            if self.forced:
                known = {r["port"]: r for r in rows}
                rows = [known.get(d, {"port": d, "device": None, "allowed": True,
                                      "named": False}) for d in self.forced]
            plan = self._slot_plan(rows)

            now = time.time()
            for row in rows:
                dev = row["port"]
                if self._stop.is_set() or dev in busy:
                    continue
                if not (row.get("allowed") or self.probe_all or self.forced):
                    continue
                fails, not_before = self._backoff.get(dev, (0, 0.0))
                if now < not_before:
                    continue
                if self._try(dev, row, plan.get(dev)):
                    break
                fails += 1
                self._backoff[dev] = (
                    fails, time.time() + min(MAX_BACKOFF, 4.0 * 2 ** min(fails - 1, 4)))
            self._stop.wait(RECONNECT_DELAY)

    def _slot_plan(self, rows):
        """Which player each controller becomes.

        Ranked by the number in the Bluetooth name, so a pair of ESP32_Client2
        and ESP32_Client3 boards always land as player 1 and player 2 in that
        order - not whichever happened to connect first.
        """
        named = [r for r in rows if r.get("named")]
        named.sort(key=lambda r: (slot_from_name(r.get("device")) or 99, r["port"]))
        return {r["port"]: i + 1 for i, r in enumerate(named[:self.slots])}

    def _try(self, dev, row=None, want_slot=None):
        row = row or {}
        try:
            ser = open_port(dev)
        except Exception:
            return False

        # A board we can positively name does not have to prove itself.  The
        # BT_Buttons firmware answers nothing at all until somebody presses a
        # button, so demanding a handshake there would reject a working board.
        hello = None
        if not row.get("named"):
            hello = self._handshake(ser)
            if not hello:
                try:
                    ser.close()
                except Exception:
                    pass
                return False

        # Over USB there is no Bluetooth name to read, but the HELLO line
        # carries the board name, so slots stay stable on a cable too.
        if want_slot is None and hello:
            for token in hello.split():
                if is_controller_name(token):
                    want_slot = slot_from_name(token)
                    break

        slot = self._free_slot(want_slot if want_slot in range(1, self.slots + 1) else None)
        if slot is None:
            try:
                ser.close()
            except Exception:
                pass
            return False

        board = Board(slot, dev, ser, self.events, self._drop,
                      expect_replies=hello is not None)
        with self._lock:
            self.boards[slot] = board
        self._backoff.pop(dev, None)
        self.events.put({"type": "connect", "player": slot, "port": dev})
        return True

    def _handshake(self, ser):
        deadline = time.time() + PROBE_TIMEOUT
        asked = 0.0
        while time.time() < deadline and not self._stop.is_set():
            now = time.time()
            if now - asked > 0.35:
                asked = now
                try:
                    ser.write(b"ID?\n")
                    ser.flush()
                except Exception:
                    return None
            try:
                raw = ser.readline()
            except Exception:
                return None
            if not raw:
                continue
            line = raw.decode("utf-8", "ignore").strip()
            if line.startswith("HELLO") or line == "PONG":
                return line
        return None
