# watch-services.ps1 - keep GLM local 9B (11434) and group chat (41300) alive.
# ASCII only on purpose: PS 5.1 decodes non-ASCII without BOM as GBK and may break.
# Started at logon by a Startup shortcut; single instance; loops every 20s.
$ErrorActionPreference = 'Continue'
$root = 'H:\GLM\group-chat'
$log = Join-Path $root 'watch-services.log'
$vbs = Join-Path $root 'services.vbs'

function L([string]$m) {
  try { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('HH:mm:ss') + ' ' + $m) -Encoding utf8 } catch {}
}

function Test-Port([int]$port, [int]$waitMs = 800) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $t = $c.ConnectAsync('127.0.0.1', $port)
    $ok = $t.Wait($waitMs)
    $c.Close()
    return $ok
  } catch { return $false }
}

# single instance
$others = @()
try {
  $others = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -match 'watch-services\.ps1' -and $_.ProcessId -ne $PID }
} catch {}
if ($others.Count -gt 0) { L ('already running pid=' + ($others | Select-Object -First 1).ProcessId + ', exit'); exit 0 }

L ('watcher start pid=' + $PID)
$rounds = 0
while ($true) {
  $rounds++
  $down = @()
  if (-not (Test-Port 11434)) { $down += '9B:11434' }
  if (-not (Test-Port 41300)) { $down += 'chat:41300' }
  if ($down.Count -gt 0) {
    L ('DOWN ' + ($down -join ' ') + ' -> start services.vbs (round ' + $rounds + ')')
    try { Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden | Out-Null } catch { L ('start failed: ' + $_.Exception.Message) }
    Start-Sleep -Seconds 25
  } else {
    if ($rounds % 30 -eq 0) { L ('ok (round ' + $rounds + ')') }
    Start-Sleep -Seconds 20
  }
}
