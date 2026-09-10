# Carnival Clicker

A clicker built for a carnival booth. Hammer the button for 60 seconds; every
click scrubs a 3D animation forward like a progress bar. Play **solo**, head to
head, or co-op, then your name goes on the leaderboard.

| Mode | Players | Scores as |
|---|---|---|
| **Solo** | 1 | your own clicks — any controller works |
| **Head to head** | 2 | two towers racing, one winner |
| **Co-op** | 2 | one shared tower, combined total |

Solo is the default, because most people turn up on their own.

Runs in a browser, driven by ESP32 controllers over Classic Bluetooth.

## Quick start

```bash
run.bat
```

First run builds a virtual environment and installs pyserial, then opens the
game. For the event itself use `run_kiosk.bat`, which launches fullscreen Edge
with no browser chrome.

Everything else is already vendored — three.js lives in `web/vendor/`, so the
booth machine needs no internet on the day.

## Controls

| | |
|---|---|
| ESP32 button | one click (in solo, *either* controller counts) |
| `A` / `Space` / `Left` | player 1, keyboard fallback |
| `L` / `Enter` / `Right` | player 2, keyboard fallback |
| `B` | leaderboard |
| `Esc` | back to the attract screen |

The keyboard fallback always works, so the booth still runs if a board dies
mid-event.

## The artwork

The models live in `web/models/` and came from the Wowza project:

| File | What it is |
|---|---|
| `soil-and-seed.glb` | soil cross-section with a seed and a sprout |
| `cherry-blossom-voxel-tree.obj` | one cherry tree |
| `cherry-blossom-voxel-tree2.obj` | the same, with the seed still showing |
| `cherry-blossom-voxel-tree3.obj` | a main tree plus four companions |
| `voxel-forest4.obj` … `voxel-forest8.obj` | 16 trees, growing to a full island |

**None of them carries an animation.** The glb was exported by
`THREE.GLTFExporter` and holds geometry only - no keyframes, no rig, no morph
targets. That is fine, because they are a *sequence*: together they form nine
growth steps, and the game scrubs through them with the click count.

- **0 - 16%** the glb: the seed swells and a sprout pushes up through the topsoil
- **16%** the underground cross-section fades out and the first tree takes over
- **16 - 100%** the eight stage files dissolve into one another in order

Two things keep that from looking steppy. The model eases toward the click count
rather than snapping to it, so growth flows on between clicks; and each stage
swells slightly across its own span before handing over, so every single click
moves something rather than only the ones that happen to trigger a swap.

Each stage brings its own terrain, so the cross-section bows out rather than
fighting it. Footprints run from 2.9 to over 12 units, so every stage is
normalised to a target width that grows only gently - and the camera pulls back
as it goes, which is what makes the ending feel like a reveal.

### They ship without materials

Only `soil-and-seed` had a `.mtl`, and its colours are already baked into the
glb. The tree and forest files reference materials that were never exported, so
colour is assigned in `scene.js` by matching the part name — `trunk`, `foliage_dark`,
`blossom_pink`, `water`, `ground` and so on. The naming is consistent across all
eight files, so this works; if a name is unrecognised it falls back to grey,
which is deliberately obvious rather than invisible.

Look for `GREEN` and `TINTS` near the top of `scene.js` to change any colour:

```js
const GREEN = {
  canopyDark:  0x14401f,   // undersides and shadowed clumps
  canopyMain:  0x1f5d2e,   // the bulk of every crown
  canopyLight: 0x38874a,   // sunlit tops
  terrain:     0x448038,   // grass and ground, one value
};
```

The canopy is deliberately *darker* than the terrain. A tree crown really is
darker than the grass around it, and that contrast is what makes the forest read
as trees rather than a flat green mat. Grass and ground share one value so the
terrain never looks patched together.

If the greens ever look washed out, the cause is usually exposure rather than
the hex values - `toneMappingExposure` and the light intensities in `initScene`
matter more than the colours do.

### Performance

The forest files are up to 2,794 separate voxel objects. Loading them as-is
would cost thousands of draw calls per frame, so each stage is merged into one
mesh per colour on load:

```
full forest      14 draw calls   43k triangles   0.37 ms/frame
two forests      27 draw calls   86k triangles   0.48 ms/frame
```

The 35 MB of `.obj` text is parsed in the background after the soil model is
ready, so the booth is playable about a second after opening rather than after
a long blank wait. `CC.perf()` in the browser console reports the current cost.

### Swapping the artwork

Drop replacements into `web/models/` with the same names. Fewer stages is fine -
a missing file just shortens the sequence.

## Architecture

```
server.py      HTTP + Server-Sent Events + leaderboard   (stdlib + pyserial)
esp32link.py   finds and holds up to 2 controllers
web/           the game: three.js scene, screens, round logic
  scene.js     the scrubbable model  (GltfModel | TowerModel)
  game.js      screens, round timer, input, leaderboard
scores.json    written after every round
```

Python owns the serial ports and the browser owns the rendering. That split is
deliberate: the serial layer already knows which ports are safe to open, and
keeping it in a separate process means a serial hiccup cannot take the game
down mid-round.

### Why clicks scrub instead of play

`mixer.setTime(progress * clip.duration)` — and `mixer.update(dt)` is never
called. The animation is therefore always a truthful picture of the click count,
and it cannot drift away from the score.

## Controllers

The game speaks two firmwares. Both work — but they are not equally suited to
an event.

| | `BT_Buttons-ClientN` (existing) | `firmware/carnival_clicker` (recommended) |
|---|---|---|
| Bluetooth name | `ESP32_Client1`..`4` | `PotClicker1` / `PotClicker2` |
| Sends | `Button 1  total: 5` | `CLK 1` |
| Held button | **blocks the whole sketch** | polled, non-blocking |
| Per click | 3 SPP writes + a heap `String` | one packet, no allocation |
| Handshake / heartbeat | none | `HELLO` + `HB` every 2 s |
| Reconnect | does not re-advertise | re-advertises on disconnect |
| Brownout | silent | reports `WARN brownout reset` |

Same wiring either way — **GPIO 23 and 22 to GND**, internal pull-ups — so
`carnival_clicker` is a drop-in reflash of your existing boards.

### Why the existing one is risky for a long event

`while (digitalRead(button_1) == LOW) delay(10);` blocks until the button is
released. If a button sticks — and after a few thousand carnival presses one
will — that board stops dead and cannot even report it. The per-click
`String` also allocates on the heap, and ESP32 heap fragmentation over a
multi-hour run is a well-known way to end up rebooting.

### Flashing carnival_clicker

Change **one line** at the top of `firmware/carnival_clicker/carnival_clicker.ino`:

```c
#define BT_NAME "PotClicker1"     // second board: "PotClicker2"
```

The trailing number decides who is player 1, so the same physical box is always
the same player. Then flash, pair, and go.

Autofire is deliberately **off**. Holding the button gives you nothing — one
press, one click, on either button. If holding produced 18 clicks a second the
first person to notice would own the leaderboard.

### Surviving a hostile radio environment

Wireless is the point of this project, so the game is built to make a dropout
*harmless* rather than to pretend one will never happen. A carnival is close to
the worst 2.4 GHz environment there is — hundreds of phones and hotspots in a
small space.

One thing in your favour: Classic Bluetooth uses **adaptive frequency hopping**,
so it actively measures which channels are busy and stops using them. It is
better suited to a crowded room than a fixed-channel protocol.

On top of that:

**The clock stops when a controller vanishes.** A full-screen `CONTROLLER LOST`
veil appears and the round freezes. The player could not click while
disconnected, so pausing means they lose no time and the result stays fair.
It resumes the instant the board is back.

**...but never forever.** If the board does not return within 25 seconds it is
written off, the round hands back to the keyboard, and play continues. A booth
cannot have a round that refuses to end with a queue waiting.

**Lost packets are made up.** Every click carries the board's running total, so
if the radio swallows a packet the game sees the total jump and adds the
difference. Interference costs you nothing on the scoreboard. This works with
both firmwares — `carnival_clicker` sends `CLK 1 42`, `BT_Buttons` already
sends `total: 42`.

**A dropped board reconnects immediately**, skipping the usual backoff, because
a controller that was working a second ago is worth retrying at once.

**The firmware asks for maximum transmit power** and keeps the radio out of
modem sleep.

#### Things worth doing on the day

- Keep the boards within a few metres, with line of sight to the laptop.
- **Avoid USB 3.0 ports near the Bluetooth antenna** — USB 3 radiates broadband
  noise right across 2.4 GHz and is a classic cause of Bluetooth trouble. Use a
  USB 2 port, or move the receiver away on a short extension.
- A cheap external USB Bluetooth dongle on a 1 m extension, raised above the
  table, will usually beat a laptop's internal antenna by a wide margin.
- Disconnect the paired headphones you are not using. Every active Bluetooth
  link is competing for the same radio.
- Fresh batteries, or a decent power bank per board. A brownout looks exactly
  like a radio fault from the PC side — the firmware prints
  `WARN brownout reset` at boot if that is what happened.

## Flags

| | |
|---|---|
| `--serial COM5` | force a port, repeatable for the second board |
| `--no-serial` | keyboard only |
| `--players 1` | single controller |
| `--probe-all` | open every port — last resort, it will interrupt other devices |
| `--port 8770` | change the http port |
| `--list-ports` | show the scan decision per port and exit |

## Starting and stopping

```bash
play.bat         REM everyday use - clears the port, opens a browser window
run_kiosk.bat    REM fullscreen Edge, for the event
stop.bat         REM stop the server
run.bat          REM plain start, no clearing (first-time setup uses this)
```

**`play.bat` is the one to use.** It stops anything already running before it
starts, which is the single most common cause of trouble: a server left over
from an earlier session keeps port 8770, so your new one never starts, and you
end up looking at an old build with the controller apparently broken. It then
opens the game in its own browser window rather than a tab you might lose.

**Stop it with `Ctrl+C` or `stop.bat`, not by killing the window.** An ESP32
accepts one Bluetooth client at a time, and a server killed mid-connection
leaves the board believing that session is still open — it will then refuse to
reconnect until you tap its EN/reset button. If a controller that was working
suddenly will not come back, reset the board first; it is almost never the PC.

The setup screen shows a build marker at the bottom. If it does not say the
build you expect, you are looking at a cached page — hard reload with
`Ctrl+Shift+R`. The server sends `no-store` on the app files to prevent this,
but a tab opened before that change can still be holding an old copy.

## Booth notes

- **Two leaderboards.** Solo and head-to-head are both one person clicking for
  60 seconds, so they share a board. Co-op is two people added together and
  would sit permanently on top of a mixed board, so teams get their own.
- After a solo round the result screen shows where that score landed
  ("that is #3 of 11 today") - a lone player has nobody in the room to measure
  against, and it is what makes them queue up again.
- The attract screen returns by itself after 90 seconds of no input, so an
  abandoned round never blocks the queue.
- Scores are written after **every** round, not on exit — a kiosk that gets
  power-cycled keeps the day's leaderboard.
- The round clock does not rely on `requestAnimationFrame`, so a blanked screen
  cannot freeze a round.
- `window.CC` in the browser console exposes the game state for troubleshooting
  on the day.
