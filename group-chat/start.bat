@echo off
rem Group chat server (user + feiyu + GLM local). ASCII only.
set GROUP_PORT=41300
if not exist H:\GLM\logs mkdir H:\GLM\logs
cd /d H:\GLM\group-chat
node server.mjs >> H:\GLM\logs\group-chat.log 2>&1
