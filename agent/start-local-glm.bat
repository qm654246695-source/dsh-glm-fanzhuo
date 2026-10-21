@echo off
rem Local 9B backend dispatcher (added 2026-10-21). ASCII only.
rem Which backend: H:\GLM\agent\.backend  ->  "llamacpp" (llama.cpp CUDA) or "python" (old transformers+bnb4).
rem Both listen on the same OpenAI-compatible endpoint 127.0.0.1:11434, model alias glm-local,
rem so nothing else (panel / group chat / CLI / watchdog) needs to know which one is running.
rem Port guard (2026-10-22): services.vbs now starts three things; if the API is already up we
rem must not load the weights again just to fail on bind.
setlocal
netstat -ano | findstr /C:":11434 " | findstr /C:"LISTENING" >nul
if not errorlevel 1 (echo [skip] 11434 already listening & exit /b 0)
set BACKEND=python
if exist "H:\GLM\agent\.backend" set /p BACKEND=<"H:\GLM\agent\.backend"
set BACKEND=%BACKEND: =%
if /i "%BACKEND%"=="llamacpp" (
  call "H:\GLM\agent\start-local-glm-llamacpp.bat"
) else (
  call "H:\GLM\agent\start-local-glm-python.bat"
)