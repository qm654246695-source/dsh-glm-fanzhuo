# watch-services.ps1 - keep GLM local 9B (11434) and group chat (41300) alive.
# ASCII only on purpose: PS 5.1 decodes non-ASCII without BOM as GBK and may break.
# Started at logon by a Startup shortcut; single instance; loops every 20s.
#
# 2026-10-21: a port check is not enough. The 9B can be "half alive": /health still
# answers 200 while every generation request hangs forever, so a pure port probe
# sees "ok" and never restarts it. Added a tiny generation probe (1 token), run
# every 10 rounds while idle. Two failures in a row while the panel is not busy
# means half-alive -> kill the model server and relaunch it.
# Run with -Once for a read-only self test (never kills, never starts anything).
param([switch]$Once, [switch]$Drill)

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

# PIDs listening on a local port (from netstat, no admin needed).
function Get-PortOwner([int]$port) {
  $res = @()
  try {
    $lines = netstat -ano | Select-String (':' + $port + '\s')
    foreach ($l in $lines) {
      $t = @(($l.Line -split '\s+') | Where-Object { $_ -ne '' })
      if ($t.Count -ge 5 -and $t[3] -eq 'LISTENING') { $res += [int]$t[4] }
    }
  } catch {}
  return @($res | Select-Object -Unique)
}

# A real 1-token generation. True only if the model actually answers.
function Test-Gen([int]$timeoutSec = 40) {
  $body = '{"model":"glm-local","messages":[{"role":"user","content":"hi"}],"max_tokens":1,"stream":false}'
  try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/v1/chat/completions' -Method Post `
      -ContentType 'application/json' -Body $body -TimeoutSec $timeoutSec -ErrorAction Stop
    if ($r -and $r.choices -and @($r.choices).Count -gt 0) { return $true }
    return $false
  } catch { return $false }
}

# Is the panel serve generating right now? Then a slow probe proves nothing.
function Test-ServeBusy() {
  try {
    $h = Invoke-RestMethod -Uri 'http://127.0.0.1:41234/health' -TimeoutSec 3 -ErrorAction Stop
    if (@($h.busy).Count -gt 0) { return $true }
    return $false
  } catch { return $false }
}

# Cooldown: the 9B needs ~30-50s to load, and a start that is already in flight looks exactly
# like "still down". Without this the loop relaunched services.vbs every 25s during a restart,
# racing several pythons for port 11434 (a drill took 54s instead of 28s because of it).
$script:lastStart = [datetime]::MinValue

function Start-Services([switch]$Force) {
  $now = Get-Date
  $ago = 9999
  if ($script:lastStart -is [datetime]) { $ago = ($now - $script:lastStart).TotalSeconds }
  if (-not $Force -and $ago -lt 60) {
    L ('start skipped: launched ' + [int]$ago + 's ago, still loading')
    return
  }
  $script:lastStart = $now
  try { Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"') -WindowStyle Hidden | Out-Null }
  catch { L ('start failed: ' + $_.Exception.Message) }
}

# Kill the model server (only if the pid really is local_glm_server) and relaunch.
function Restart-9B([string]$why) {
  $pids = Get-PortOwner 11434
  if ($pids.Count -eq 0) {
    L ('9B: no listener on 11434 (' + $why + ') -> start services.vbs')
    Start-Services -Force
    return
  }
  $par = 0
  try { $par = (Get-CimInstance Win32_Process -Filter ('ProcessId=' + $PID)).ParentProcessId } catch {}
  $killed = @()
  foreach ($p in $pids) {
    if ($p -eq $PID -or $p -eq $par) { L ('9B: skip own pid ' + $p); continue }
    $cl = ''
    try { $ci = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p); if ($ci) { $cl = '' + $ci.CommandLine } } catch {}
    # 2026-10-21 backend switch: python local_glm_server OR llama.cpp llama-server.
    if ($cl -notmatch 'local_glm_server|llama-server') { L ('9B: pid ' + $p + ' is not the model server, skip') ; continue }
    try { Stop-Process -Id $p -Force -ErrorAction Stop; $killed += $p }
    catch { L ('9B: kill ' + $p + ' failed: ' + $_.Exception.Message) }
  }
  if ($killed.Count -eq 0) { L ('9B: nothing killed (' + $why + ')'); return }
  for ($i = 0; $i -lt 20; $i++) { if (-not (Test-Port 11434)) { break }; Start-Sleep -Milliseconds 500 }
  L ('9B: killed pid ' + ($killed -join ',') + ' (' + $why + ') -> start services.vbs')
  Start-Services -Force
}

if ($Once) {
  $ok9 = Test-Port 11434
  $okc = Test-Port 41300
  $busy = Test-ServeBusy
  $gen = 'not-run'
  if ($ok9) { if (Test-Gen 40) { $gen = 'ok' } else { $gen = 'FAILED' } }
  L ('selftest: 9B=' + $ok9 + ' chat=' + $okc + ' busy=' + $busy + ' gen=' + $gen)
  Write-Output ('selftest: 9B=' + $ok9 + ' chat=' + $okc + ' busy=' + $busy + ' gen=' + $gen)
  exit 0
}

# Rehearsal: really kill the model server, relaunch it, and prove generation works.
# Only run this while nobody is talking to GLM (it costs ~40s of downtime).
if ($Drill) {
  if (Test-ServeBusy) { L 'drill aborted: panel busy'; Write-Output 'drill aborted: panel busy'; exit 2 }
  L ('drill start: half-alive rehearsal, port was ' + (Test-Port 11434))
  Restart-9B 'drill'
  $ok = $false
  $waited = 0
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 2
    $waited = ($i + 1) * 2
    if ((Test-Port 11434) -and (Test-Gen 20)) { $ok = $true; break }
  }
  L ('drill result: port=' + (Test-Port 11434) + ' gen=' + $ok + ' waited=' + $waited + 's')
  Write-Output ('drill: port=' + (Test-Port 11434) + ' gen=' + $ok + ' waited=' + $waited + 's')
  if ($ok) { exit 0 } else { exit 3 }
}

# single instance
# Careful: a shell that merely *mentions* this script (e.g. the DSH pwsh tool invoking it, whose
# command line embeds the path inside -Command "...") also matches 'watch-services.ps1'. Matching
# CommandLine alone made a fresh watcher see its caller and exit at once, leaving the services
# unguarded. Real watchers are launched with -File and never with -Command.
$others = @()
try {
  $others = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction Stop |
    Where-Object {
      $_.CommandLine -match 'watch-services\.ps1' -and
      $_.ProcessId -ne $PID -and
      $_.CommandLine -notmatch '\-Command' -and
      $_.CommandLine -notmatch '\-(Once|Drill)'
    })
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
    Start-Services
    Start-Sleep -Seconds 25
  } else {
    $heartbeat = ($rounds % 30 -eq 0)
    $note = ''
    if ($rounds % 10 -eq 0) {
      if (Test-ServeBusy) {
        $note = 'probe skipped,panel busy'
      } elseif (Test-Gen 40) {
        $note = 'gen ok'
      } else {
        Start-Sleep -Seconds 10
        if (Test-Gen 40) {
          $note = 'gen slow once,ok on retry'
        } elseif (Test-ServeBusy) {
          $note = 'probe failed twice,panel busy,no kill'
        } else {
          L ('9B half-alive: health 200, generation dead (round ' + $rounds + ')')
          Restart-9B 'probe-fail'
          $note = 'restarted after probe fail'
        }
      }
    }
    if ($heartbeat) {
      if ($note) { L ('ok (round ' + $rounds + ') ' + $note) } else { L ('ok (round ' + $rounds + ')') }
    }
    Start-Sleep -Seconds 20
  }
}
