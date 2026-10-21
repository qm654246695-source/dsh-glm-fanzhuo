@echo off
rem OLD backend: transformers + bitsandbytes 4bit (about 20 tok/s). Kept for rollback.
rem Start local GLM (9B on H: drive) as an OpenAI-compatible server. ASCII only.
set HF_DEACTIVATE_ASYNC_LOAD=1
set HF_HUB_OFFLINE=1
set TRANSFORMERS_OFFLINE=1
if not exist H:\GLM\logs mkdir H:\GLM\logs
cd /d H:\GLM\agent
H:\GLM\venv\Scripts\python.exe local_glm_server.py --quant bnb4 --port 11434 --max-new 512 >> H:\GLM\logs\local-glm.log 2>&1
