# 启动 GLM 的对话 —— 双击「和GLM聊天.bat」会跑到这里
# 参数会原样转给 glm-chat.mjs（例如 --sessions / --log / --new "..."）

chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$env:PYTHONIOENCODING = 'utf-8'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'glm-chat.mjs'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '找不到 node，没法起 GLM。' -ForegroundColor Red
  exit 1
}

Push-Location $here
try {
  if ($args.Count -gt 0) {
    & node $script @args
  } else {
    & node $script
  }
} finally {
  Pop-Location
}
