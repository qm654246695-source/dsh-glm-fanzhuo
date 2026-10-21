@echo off
rem NEW backend: llama.cpp CUDA build 11756, same OpenAI-compatible endpoint on 11434.
rem Weights: GLM-4.6V-Flash-Q4_K_M.gguf + mmproj-F16.gguf (vision). ASCII only on purpose.
rem Rollback: write "python" into H:\GLM\agent\.backend (no newline) and restart the 9B,
rem           or run: taskkill /f /im llama-server.exe  then  wscript H:\GLM\group-chat\services.vbs
set PATH=H:\GLM\llamacpp\cuda;%PATH%
if not exist H:\GLM\logs mkdir H:\GLM\logs
cd /d H:\GLM\llamacpp\cuda
llama-server.exe ^
  --model H:\GLM\models\gguf\GLM-4.6V-Flash-Q4_K_M.gguf ^
  --mmproj H:\GLM\models\gguf\mmproj-F16.gguf ^
  --alias glm-local --host 127.0.0.1 --port 11434 ^
  --ctx-size 16384 --n-predict 2048 --n-gpu-layers 99 ^
  --parallel 1 --flash-attn on --jinja --no-webui ^
  --chat-template-kwargs "{\"enable_thinking\": false}" ^
  >> H:\GLM\logs\local-llamacpp.log 2>&1
