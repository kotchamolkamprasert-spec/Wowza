<#
  67 Speed — booth server (Windows PowerShell 5.1, no installs, no Administrator)

  Every booth machine runs this same script. One of them is the "host" that keeps
  the shared board; the others just name it:

      # On the host machine:
      .\booth-server.ps1

      # On every other booth machine (use the IP the host prints):
      .\booth-server.ps1 -ScoreServer 192.168.1.50

  Then open http://localhost:8000/ on each machine.

  Why every machine serves the game to itself instead of everyone opening the
  host's address: Chrome only allows the webcam in a "secure context" — https://,
  localhost, or file://. A plain http://192.168.x.x page is NOT one, so the camera
  would be blocked on every machine except the host. Serving from localhost avoids
  that with no certificates and no browser flags; only the scores cross the wifi.

  This uses a raw TcpListener rather than HttpListener because HttpListener needs
  an Administrator shell to accept connections from the network, and TcpListener
  on a high port does not.
#>
param(
  [string]$ScoreServer = "",   # IP of the host machine; blank = this machine is the host
  [int]$Port = 8000
)

$ErrorActionPreference = 'Stop'
$root      = $PSScriptRoot
$stateFile = Join-Path $root 'scores.json'
$lockFile  = Join-Path $root 'scores.lock'
$utf8      = New-Object System.Text.UTF8Encoding($false)

$MAX_HEADER = 16384    # a request head larger than this is a mistake or an attack
$MAX_BODY   = 65536
$MAX_BOARD  = 20

# ---------------------------------------------------------------- state -------
# Every number that comes off the wire or off disk goes through here. An
# unclamped value persisted once would throw on the next [int] cast at startup
# and take the whole day's board down with it.
function Clamp-Int($value, [int]$lo, [int]$hi) {
  $n = 0
  if ($null -eq $value) { return $lo }
  if (-not [int]::TryParse([string]$value, [ref]$n)) { return $lo }
  if ($n -lt $lo) { return $lo }
  if ($n -gt $hi) { return $hi }
  return $n
}

function ConvertTo-State($o) {
  $lb = @()
  if ($o.leaderboard) {
    foreach ($e in @($o.leaderboard)) {
      $nm = ''
      if ($e.name) { $nm = [string]$e.name }
      $lb += [PSCustomObject]@{
        name  = $nm
        count = (Clamp-Int $e.count 0 100000)
        ts    = (Clamp-Int $e.ts 0 2147483647)
      }
    }
  }
  return @{
    leaderboard    = @($lb | Select-Object -First $MAX_BOARD)
    communityTotal = (Clamp-Int $o.communityTotal 0 2000000000)
    treesPlanted   = (Clamp-Int $o.treesPlanted   0 2000000000)
  }
}

function Read-One($path) {
  $o = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
  return (ConvertTo-State $o)
}

function Read-State {
  # The backup is tried whenever the primary cannot be loaded OR is missing —
  # a crash during the swap can leave exactly that combination behind.
  if (Test-Path $stateFile) {
    try { return (Read-One $stateFile) }
    catch { Write-Host "  ! scores.json unreadable - trying the backup" -ForegroundColor Yellow }
  }
  if (Test-Path "$stateFile.bak") {
    try {
      $s = Read-One "$stateFile.bak"
      Write-Host "  + recovered the board from scores.json.bak" -ForegroundColor Green
      return $s
    } catch { Write-Host "  ! backup unreadable too" -ForegroundColor Yellow }
  }
  return @{ leaderboard=@(); communityTotal=0; treesPlanted=0 }
}

function Write-State($s) {
  $tmp = "$stateFile.tmp"
  [System.IO.File]::WriteAllText($tmp, ($s | ConvertTo-Json -Depth 6), $utf8)
  if (Test-Path $stateFile) {
    # File::Replace is atomic and writes the backup in the same operation, so a
    # power cut can never leave the folder without a readable board.
    [System.IO.File]::Replace($tmp, $stateFile, "$stateFile.bak", $true)
  } else {
    Move-Item $tmp $stateFile -Force
  }
}

# ------------------------------------------------------- single instance ------
# Two copies in one folder would each hold their own snapshot and overwrite the
# other's scores on every save, so refuse to start rather than corrupt the board.
try {
  $lock = [System.IO.File]::Open($lockFile, 'OpenOrCreate', 'ReadWrite', 'None')
} catch {
  Write-Host ""
  Write-Host "  A booth server is already running in this folder." -ForegroundColor Red
  Write-Host "  Use that window. Starting a second one would overwrite the scores." -ForegroundColor Yellow
  exit 1
}

$state = Read-State

$mime = @{
  '.html'='text/html; charset=utf-8'; '.css'='text/css; charset=utf-8'
  '.js'='text/javascript; charset=utf-8'; '.json'='application/json; charset=utf-8'
  '.png'='image/png'; '.jpg'='image/jpeg'; '.svg'='image/svg+xml'; '.ico'='image/x-icon'
}

$apiBase = "http://localhost:$Port"
if ($ScoreServer -ne '') { $apiBase = "http://${ScoreServer}:$Port" }

function Send-Response($stream, [int]$code, [string]$type, [byte[]]$body) {
  $status = @{200='OK';204='No Content';400='Bad Request';403='Forbidden';404='Not Found';413='Payload Too Large';500='Server Error'}[$code]
  $head  = "HTTP/1.1 $code $status`r`n"
  if ($type) { $head += "Content-Type: $type`r`n" }
  $head += "Access-Control-Allow-Origin: *`r`n"
  $head += "Access-Control-Allow-Headers: Content-Type`r`n"
  $head += "Access-Control-Allow-Methods: GET, POST, OPTIONS`r`n"
  $head += "Access-Control-Max-Age: 86400`r`n"   # spares a preflight per score
  $head += "Cache-Control: no-store`r`n"
  $head += "Content-Length: $($body.Length)`r`nConnection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
  $stream.Write($hb, 0, $hb.Length)
  if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
  $stream.Flush()
}
function Send-Text($stream, [int]$code, [string]$type, [string]$text) {
  Send-Response $stream $code $type $utf8.GetBytes($text)
}
function Send-Json($stream, $obj) {
  Send-Text $stream 200 'application/json; charset=utf-8' ($obj | ConvertTo-Json -Depth 6)
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $Port)
try { $listener.Start() } catch {
  Write-Host "`n  Could not listen on port $Port." -ForegroundColor Red
  Write-Host "  Another program is using it. Try:  .\booth-server.ps1 -Port 8001" -ForegroundColor Yellow
  Write-Host "  (use the same -Port on every machine)" -ForegroundColor Yellow
  Write-Host "  ($($_.Exception.Message))" -ForegroundColor DarkGray
  $lock.Close(); Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
  exit 1
}

Write-Host ""
Write-Host "  67 Speed booth server" -ForegroundColor Green
Write-Host "  ---------------------"
Write-Host "  Play on this machine:  http://localhost:$Port/" -ForegroundColor White

if ($ScoreServer -eq '') {
  Write-Host "  This machine is the HOST for the shared board." -ForegroundColor Cyan
  Write-Host "  Scores file: $stateFile" -ForegroundColor DarkGray
  # Labelled by adapter so staff can tell the wifi address from a virtual one.
  $nics = @(Get-WmiObject Win32_NetworkAdapterConfiguration | Where-Object { $_.IPEnabled })
  $shown = 0
  Write-Host "  On the other booth PCs run:" -ForegroundColor Cyan
  foreach ($n in $nics) {
    foreach ($ip in @($n.IPAddress)) {
      if ($ip -and $ip -notmatch ':' -and $ip -ne '127.0.0.1' -and $ip -notlike '169.254.*') {
        Write-Host ("     .\booth-server.ps1 -ScoreServer {0}   [{1}]" -f $ip, $n.Description) -ForegroundColor White
        $shown++
      }
    }
  }
  if ($shown -eq 0) { Write-Host "     (no network address - is the wifi connected?)" -ForegroundColor Yellow }
  Write-Host "  If the others cannot connect, run ONCE in an Administrator PowerShell:" -ForegroundColor DarkGray
  Write-Host "    netsh advfirewall firewall add rule name=`"67 Speed booth`" dir=in action=allow protocol=TCP localport=$Port" -ForegroundColor DarkGray
} else {
  # Prove the link now, rather than discovering at pack-up that nothing synced.
  Write-Host "  Sending scores to host: $apiBase" -ForegroundColor Cyan
  try {
    $probe = Invoke-RestMethod "$apiBase/api/state" -TimeoutSec 4
    Write-Host "  + reached the host (board total so far: $($probe.communityTotal))" -ForegroundColor Green
  } catch {
    Write-Host "  ! CANNOT reach the host at $apiBase" -ForegroundColor Red
    Write-Host "    Same wifi? Correct IP? Firewall allowed on the host PC?" -ForegroundColor Yellow
    Write-Host "    The booth still works - scores stay on this machine until it connects." -ForegroundColor Yellow
  }
}
Write-Host "  Ctrl+C to stop.`n"
Write-Host "  (Thai names may show as ???? in this console - the saved file is correct.)" -ForegroundColor DarkGray

# ------------------------------------------------------------ request loop ----
$acceptFails = 0
try {
  while ($true) {
    $client = $null
    try { $client = $listener.AcceptTcpClient(); $acceptFails = 0 }
    catch [System.Net.Sockets.SocketException] {
      # A peer that resets between SYN and accept, or a brief adapter drop, must
      # not end the day. Only give up if it keeps happening.
      $acceptFails++
      if ($acceptFails -gt 20) {
        Write-Host "  ! listener failed $acceptFails times in a row - stopping. Restart the script." -ForegroundColor Red
        break
      }
      continue
    }
    catch {
      Write-Host "  ! listener stopped: $($_.Exception.Message)" -ForegroundColor Red
      break
    }
    if ($null -eq $client) { continue }

    try {
      $client.ReceiveTimeout = 3000
      $client.SendTimeout    = 3000
      $stream = $client.GetStream()

      # ---- read the head, bounded in both size and scan cost ----
      $buf = New-Object byte[] 8192
      $ms  = New-Object System.IO.MemoryStream
      $headerEnd = -1
      $scanFrom  = 3
      $tooBig    = $false
      while ($headerEnd -lt 0) {
        $n = $stream.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        $ms.Write($buf, 0, $n)
        if ($ms.Length -gt $MAX_HEADER) { $tooBig = $true; break }
        $arr = $ms.ToArray()
        for ($i = $scanFrom; $i -lt $arr.Length; $i++) {
          if ($arr[$i-3] -eq 13 -and $arr[$i-2] -eq 10 -and $arr[$i-1] -eq 13 -and $arr[$i] -eq 10) { $headerEnd = $i; break }
        }
        # Never rescan from the start again: that made the loop O(n^2).
        if ($headerEnd -lt 0) { $scanFrom = [Math]::Max(3, $arr.Length) }
      }
      if ($tooBig)      { Send-Text $stream 400 'text/plain' 'headers too large'; $client.Close(); continue }
      if ($headerEnd -lt 0) { $client.Close(); continue }

      $all     = $ms.ToArray()
      $headers = [System.Text.Encoding]::ASCII.GetString($all, 0, $headerEnd + 1)
      $lines   = $headers -split "`r`n"
      $parts   = $lines[0] -split ' '
      $method  = $parts[0]
      $target  = $parts[1]

      # Parsed as long first: [int] on an oversized value throws before any
      # size check could reject it.
      $clen = 0
      foreach ($l in $lines) {
        if ($l -match '^(?i)Content-Length:\s*(\d+)') {
          $asLong = [long]0
          if (-not [long]::TryParse($Matches[1], [ref]$asLong)) { $asLong = [long]::MaxValue }
          if ($asLong -gt $MAX_BODY) { $clen = -1 } else { $clen = [int]$asLong }
        }
      }
      if ($clen -lt 0) { Send-Text $stream 413 'text/plain' 'too large'; $client.Close(); continue }

      $bodyMs = New-Object System.IO.MemoryStream
      $have = $all.Length - ($headerEnd + 1)
      if ($have -gt 0) { $bodyMs.Write($all, $headerEnd + 1, $have) }
      while ($bodyMs.Length -lt $clen) {
        $want = [Math]::Min([int]$buf.Length, [int]($clen - $bodyMs.Length))
        $n = $stream.Read($buf, 0, $want)
        if ($n -le 0) { break }
        $bodyMs.Write($buf, 0, $n)
      }
      $body = [System.Text.Encoding]::UTF8.GetString($bodyMs.ToArray())

      $path = ($target -split '\?')[0]
      $path = [System.Uri]::UnescapeDataString($path)

      if ($method -eq 'OPTIONS') { Send-Response $stream 204 $null (New-Object byte[] 0); $client.Close(); continue }

      if ($path -eq '/api/state') { Send-Json $stream $state; $client.Close(); continue }

      if ($path -eq '/api/round' -and $method -eq 'POST') {
        $in = $null
        try { $in = $body | ConvertFrom-Json } catch { }
        if ($null -eq $in) { Send-Text $stream 400 'text/plain' 'bad json'; $client.Close(); continue }

        # Both numbers are clamped through TryParse. A raw [int] cast here would
        # throw on "abc", 1e12 or an array and leave the client with no reply at
        # all — and, for planted, only after communityTotal had been changed.
        $reps = Clamp-Int $in.count   0 100000
        $pl   = Clamp-Int $in.planted 0 100

        $state.communityTotal = [int][Math]::Min(2000000000, [double]$state.communityTotal + $reps)
        $state.treesPlanted   = [int][Math]::Min(2000000000, [double]$state.treesPlanted + $pl)

        $nm = ''
        if ($in.name) { $nm = ([string]$in.name).Trim() }
        if ($nm -ne '' -and $reps -gt 0) {
          if ($nm.Length -gt 16) { $nm = $nm.Substring(0,16) }
          $entry = [PSCustomObject]@{
            name  = $nm
            count = $reps
            ts    = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
          }
          # ts breaks ties: Sort-Object has no -Stable in 5.1, so equal scores
          # would otherwise reshuffle on every POST and evict an arbitrary entry.
          $state.leaderboard = @(@($state.leaderboard) + $entry |
            Sort-Object -Property @{Expression='count';Descending=$true}, @{Expression='ts';Descending=$false} |
            Select-Object -First $MAX_BOARD)
          Write-Host ("  + {0,-16} {1,5} reps" -f $nm, $reps) -ForegroundColor Green
        } elseif ($reps -gt 0) {
          Write-Host ("  + {0,-16} {1,5} reps" -f '(no name)', $reps) -ForegroundColor DarkGray
        }

        # Saving must never cost the player their reply: the score is already in
        # memory, so a locked or full disk is reported and play continues.
        try { Write-State $state }
        catch { Write-Host "  ! could not save scores.json: $($_.Exception.Message)" -ForegroundColor Red }
        Send-Json $stream $state
        $client.Close(); continue
      }

      if ($path -eq '/config.js') {
        Send-Text $stream 200 'text/javascript; charset=utf-8' "window.SCORE_SERVER = `"$apiBase`";"
        $client.Close(); continue
      }

      # ---- static files ----
      if ($path -eq '/') { $path = '/index.html' }
      $full = $null
      try {
        $full = [System.IO.Path]::GetFullPath((Join-Path $root ($path.TrimStart('/').Replace('/','\'))))
      } catch {
        # %00, %22, %7C and friends decode to characters GetFullPath rejects.
        Send-Text $stream 400 'text/plain' 'bad path'; $client.Close(); continue
      }
      # Trailing separator matters: without it "/../Pattadon-secret/x" passes a
      # bare StartsWith on the folder name.
      $rootFull = [System.IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
      if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-Text $stream 403 'text/plain' 'forbidden'
      } elseif (Test-Path $full -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($full).ToLower()
        $type = $null; if ($mime.ContainsKey($ext)) { $type = $mime[$ext] }
        Send-Response $stream 200 $type ([System.IO.File]::ReadAllBytes($full))
      } else {
        Send-Text $stream 404 'text/plain' 'not found'
      }
      $client.Close()
    } catch {
      # Browsers routinely open a socket and abandon it (preconnect, tab close),
      # so transport errors are normal and must not fill the staff console.
      $m = $_.Exception.Message
      if ($m -match 'transport connection|forcibly closed|did not properly respond|aborted') {
        Write-Host "  . dropped connection" -ForegroundColor DarkGray
      } else {
        Write-Host "  ! $m" -ForegroundColor Red
      }
      try { $client.Close() } catch { }
    }
  }
} finally {
  try { $listener.Stop() } catch { }
  try { $lock.Close() } catch { }
  Remove-Item $lockFile -Force -ErrorAction SilentlyContinue
  Write-Host "`n  Server stopped. Scores are saved in $stateFile" -ForegroundColor Green
}
