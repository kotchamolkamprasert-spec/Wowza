# 67 Speed — shared scoreboard over the wireless network

Lets several booth computers share one leaderboard and one combined rep total.
No installs, no Administrator, no certificates. Windows PowerShell 5.1 is enough.

## Run it

Every machine runs the same script. One of them is the **host** that keeps the scores.

**On the host machine:**

```bash
powershell -ExecutionPolicy Bypass -File .\booth-server.ps1
```

It prints the address to give the others, labelled by adapter so you can tell the
wifi one from a virtual one:

```
Play on this machine:  http://localhost:8000/
This machine is the HOST for the shared board.
On the other booth PCs run:
   .\booth-server.ps1 -ScoreServer 172.20.10.4   [Intel(R) Wi-Fi 6 AX201]
```

**On every other booth machine:**

```bash
powershell -ExecutionPolicy Bypass -File .\booth-server.ps1 -ScoreServer 172.20.10.4
```

Each client checks the host at startup and says plainly whether it got through:

```
+ reached the host (board total so far: 1450)
```

Then open **`http://localhost:8000/`** on each machine. Not the host's IP — see below.

If port 8000 is taken, add `-Port 8001` (use the same port everywhere).

## Why each machine opens `localhost` instead of the host's address

Chrome only allows the webcam in a **secure context**: `https://`, `localhost`, or
`file://`. A plain `http://192.168.x.x` page is *not* one, so opening the host's
address directly would leave the camera dead on every machine except the host.

Each machine therefore serves the game to itself over `localhost`, where the camera
works, and only the **scores** travel across the wifi. That avoids self-signed
certificates and browser flags entirely.

## What it does

| Route | Purpose |
|---|---|
| `GET /api/state` | current leaderboard, combined rep total, trees planted |
| `POST /api/round` | `{name, count, planted}` — one call per round, never per rep |
| `GET /config.js` | tells the page which host to talk to (generated from the launch command) |
| anything else | the game's own files |

The board keeps the top 20 scores in `scores.json` next to the script. Saves are
atomic and keep a `scores.json.bak`, so a power cut cannot leave the folder without
a readable board — and if the main file is damaged the server recovers from the
backup on the next start, losing at most the final round.

A round with an empty name still adds its reps to the combined total but is not
listed on the board, which is what pressing **ข้าม** does.

Only one server may run per folder. A second one refuses to start rather than
overwrite the first one's scores.

## If the wifi drops

The booth keeps working. The leaderboard heading changes to
`(ออฟไลน์ — คะแนนล่าสุดที่ซิงก์ไว้)`, rounds played during the outage are queued in
the browser, and they are sent automatically once the host is reachable again.
Nothing is lost and nobody has to restart anything.

Opening `index.html` by double-clicking (no server at all) also still works — the page
keeps its scores to itself and the heading reads `(เก็บในเครื่องนี้เท่านั้น)`.

## If the other machines cannot reach the host

The client prints a red warning at startup rather than failing silently. The usual
cause is the Windows firewall on the **host**. Run once there, in an Administrator
PowerShell:

```bash
netsh advfirewall firewall add rule name="67 Speed booth" dir=in action=allow protocol=TCP localport=8000
```

Also check both machines are on the same wifi. Some guest networks isolate clients
from each other, which blocks this entirely; each booth still runs on its own scores.

## Before the fair

Clear the test scores: stop the server (Ctrl+C), delete `scores.json`,
`scores.json.bak` and `scores.lock`, then start it again. Deleting the file while the
server is running has no effect, because it keeps the board in memory and writes it
back out.

Thai names may display as `????` in the PowerShell console — that is only the console
font. The saved file and the leaderboard on screen are correct.
