@echo off
rem 肃正协议的手：第二个 glm-chat.mjs --serve 实例，云端 DeepSeek，根目录 F:\DSH。
rem 由 start-suzheng.vbs / 看门狗脱离进程树启动，监听 127.0.0.1:41235。
rem 先查端口：已经在听就直接退出，避免被 services.vbs 重复拉起后跑到 41236。
rem key 在 F:\DSH\home\.key（纯 ASCII），由 glm-chat.mjs 自己读 HOME\.key。
rem node 用绝对路径：看门狗是 WMI 起的，PATH 不一定带 F:\Jave（2026-10-22 踩过）。
setlocal
netstat -ano | findstr /C:":41235 " | findstr /C:"LISTENING" >nul
if not errorlevel 1 (echo [skip] 41235 already listening & exit /b 0)
set GLM_HOME=F:\DSH\home
set GLM_ROOT=F:\DSH
set GLM_BASE=https://api.deepseek.com/v1/chat/completions
set GLM_MODEL=deepseek-flash
set GLM_PORT=41235
set GLM_EXTRA_WRITABLE=.
if not exist F:\DSH\home\.chat mkdir F:\DSH\home\.chat
cd /d H:\GLM\agent
F:\Jave\node.exe "H:\GLM\agent\glm-chat.mjs" --serve --port 41235 >> F:\DSH\home\serve.log 2>&1