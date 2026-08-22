# Bluetooth serial terminal for the ESP32.
#
#   .\bt_terminal.ps1 -List          show every Bluetooth COM port and its device
#   .\bt_terminal.ps1                auto-pick the ESP32 and start listening
#   .\bt_terminal.ps1 -Port COM7     use a specific port
#
# Press Ctrl+C to stop.

param(
  [string]$Port = "",
  [int]$Baud = 115200,
  [string]$Match = "ESP32",
  [switch]$List
)

function Get-BtComPorts {
  $all = Get-CimInstance Win32_PnPEntity

  # Build a MAC -> friendly name table from the paired-device entries.
  $names = @{}
  foreach ($d in $all) {
    if ($d.DeviceID -match '^BTHENUM.DEV_([0-9A-Fa-f]{12})') {
      $names[$Matches[1].ToUpper()] = $d.Name
    }
  }

  $ports = @()
  foreach ($e in $all) {
    if ($e.Name -notmatch 'Standard Serial over Bluetooth link \(COM\d+\)') { continue }

    $com = ""
    if ($e.Name -match '\((COM\d+)\)') { $com = $Matches[1] }

    # The remote device's MAC address is buried in the device ID.
    $mac = ""
    if ($e.DeviceID -match '&([0-9A-Fa-f]{12})_C') { $mac = $Matches[1].ToUpper() }

    $device = "(incoming port)"
    if ($mac -ne "") {
      if ($names.ContainsKey($mac)) {
        $device = $names[$mac]
      } else {
        $device = "(unknown device)"
      }
    }

    $ports += [PSCustomObject]@{
      Port   = $com
      Device = $device
      MAC    = $mac
    }
  }

  return $ports | Sort-Object Port -Unique
}

$found = Get-BtComPorts

if ($List) {
  if ($found.Count -eq 0) {
    Write-Output "No Bluetooth COM ports found."
  } else {
    $found | Format-Table -AutoSize
  }
  exit 0
}

if ($Port -eq "") {
  $hit = $found | Where-Object { $_.Device -match $Match } | Select-Object -First 1
  if ($null -eq $hit) {
    Write-Output "Could not find a paired Bluetooth device matching '$Match'."
    Write-Output ""
    Write-Output "Ports available right now:"
    $found | Format-Table -AutoSize
    Write-Output "Pair the ESP32 first, then re-run. Or pass -Port COMx directly."
    exit 1
  }
  $Port = $hit.Port
  Write-Output "Found '$($hit.Device)' on $Port"
}

Write-Output "Opening $Port at $Baud baud. Ctrl+C to stop."
Write-Output "----------------------------------------"

$sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, 'None', 8, 'One'
$sp.ReadTimeout = 500
$sp.NewLine = "`n"

try {
  $sp.Open()
} catch {
  Write-Output "Could not open $Port : $($_.Exception.Message)"
  Write-Output "The ESP32 may be out of range, powered off, or the port is in use."
  exit 1
}

try {
  while ($true) {
    try {
      $line = $sp.ReadLine()
      $stamp = Get-Date -Format "HH:mm:ss"
      Write-Output "[$stamp] $($line.TrimEnd([char]13))"
    } catch [System.TimeoutException] {
      # nothing arrived in the last half second, keep waiting
    }
  }
} finally {
  if ($sp.IsOpen) { $sp.Close() }
  Write-Output "----------------------------------------"
  Write-Output "Port closed."
}
