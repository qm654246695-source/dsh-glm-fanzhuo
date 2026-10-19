# GLM 工 + 饭桌

一套「让 GLM 住进自己电脑里」的小工具，全部零依赖 Node / Python 单文件，住在 Windows 上的一块专属盘里。

两个东西：

- **GLM 工**：命令行单次调用 + 带围栏屋子的可续对话 agent（原生 function calling 六个工具）+ 一个本地 9B 推理服务（GLM-4.6V-Flash，4-bit，16 GB 显卡可跑）。
- **饭桌**：一个本地群聊，用户可以同时和几个 AI 说话（本仓库自带「肥鱼」「GLM」两个人格位，可自己加）。成员之间看得到彼此的发言，可以 @ 点名、可以单独喊某一位插话。
- 附带两个 **DSH 左侧栏插件**（`plugins/`）：`glm-panel`（单聊面板）与 `group-chat-panel`（饭桌的同源转发）。

> 仓库**不含模型权重**。19 GB 的权重请自己按下面「本地 9B」一节下载。

## 目录

```
agent/        glm.mjs（单次调用）、glm-chat.mjs（对话 agent + --serve 面板后端）、
              local_glm_server.py（本地 9B 的 OpenAI 兼容服务）、启动器
home/         她的屋子骨架：PERSONA.md（人格）、README.md；notes/ inbox/ .chat/ 运行时自建
group-chat/   饭桌：server.mjs + index.html + config.json + say.mjs + 看门狗脚本
plugins/      DSH 插件：glm-panel（左侧栏聊天面板）、group-chat-panel（/group-chat/* 转发）
docs/         架构.md：端口、数据落点、两套会话存储、谁在说话、看门狗、三个坑
```

## 快速开始

需要：Windows 10/11、Node ≥ 22、Python 3.12+（本地 9B 用）。宿主要是 DSH（桌面版）才需要 `plugins/`。

```powershell
# 1) 把本仓库放到你的数据盘，例如 H:\GLM
# 2) 放 key：agent\.key 里写智谱 API key（或设环境变量 GLM_API_KEY）
node agent\glm.mjs "你好"                     # 单次调用（默认 glm-5.3-flash）
node agent\glm-chat.mjs "盘一下 notes"         # 带屋子的对话（续上次会话）
node agent\glm-chat.mjs --new --model glm-5.2 --no-think "快问快答"
node agent\glm.mjs --image a.png "描述这张图"  # 看图（glm-4v / glm-4.6v）
```

饭桌：

```powershell
cd group-chat
node server.mjs        # → http://127.0.0.1:41300
# 或者双击 start.bat（隐藏窗口后台）
```

成员在 `group-chat/config.json` 里配：`kind` 支持 `deepseek`（云端，读 `Api.txt` 第一行 key）、
`openai`（任何 OpenAI 兼容端点，如本地 11434）、`glmserve`（走 `glm-chat.mjs --serve`，带工具）。

真肥鱼（人）想亲自插话：`node group-chat/say.mjs "要说的话"`。

## 本地 9B（可选）

`agent/local_glm_server.py` 是给 GLM-4.6V-Flash 9B 用的 OpenAI 兼容服务。

1. 从 ModelScope 拉官方权重（大文件走国内源，HuggingFace 在本机不通）：
   `ZhipuAI/GLM-4.6V-Flash` 的 4 个 safetensors + config/tokenizer，放到 `models\glm46v-flash-official\`。
2. 建 venv，装 `transformers>=5.9`、`accelerate`、`bitsandbytes`、`pillow`（torch 按你的卡装 CUDA 版）。
3. 启动：

```powershell
agent\start-local-glm.bat      # 127.0.0.1:11434，bnb 4-bit
```

实测（RTX 5080 16 GB）：显存 6.7 GiB、加载约 30 秒、17–19 tok/s，支持看图与工具调用。

## 配置与端口

| 项 | 默认 | 说明 |
|---|---|---|
| 饭桌 | `127.0.0.1:41300` | `GROUP_PORT` 可改；`/say` `/nudge` `/state` `/events`(SSE) |
| 面板后端 | `127.0.0.1:41234` | `glm-chat.mjs --serve`，端口写 `home/.chat/server.json` |
| 本地 9B | `127.0.0.1:11434` | `GLM_LOCAL_BASE` 可改 |
| 后端开关 | `home/.chat/backend` | 写 `local` 或 `cloud`，插件 30 秒内自动切换 |

环境变量：`GLM_API_KEY`、`GLM_BASE`、`GLM_LOCAL_BASE`、`GLM_HOME`、`GROUP_PORT`、`GLM_VERBOSE`、`GLM_SHOW_USAGE`。

## 踩过的坑（写下来省你两天）

- **思考型模型会「只思考不出正文」**：5.3 系列给多少 `max_tokens` 就往 reasoning 里烧多少。`glm.mjs` 内置三轮重试（原样 → 加长 → 8192+降 effort）。`reasoning_effort` 只认 `low|high|max`。
- **`thinking:{type:"disabled"}` 对 5.3 系列无效**（HTTP 400 `1210`），对 4.6/5.2/5-turbo 有效。
- **GLM 的工具调用是文本 XML**（`<tool_call>name<arg_key>…`），`local_glm_server.py` 把它解析回 OpenAI `tool_calls`。
- **`--serve` 有两套会话存储**：CLI 用 `.chat/sessions/`，面板用 `.chat/panel/sessions/`（+ `current`、`index.json`）。
- **PS 5.1 + curl 发中文 JSON**：必须写文件再 `--data-binary "@file"`；`Out-File -Encoding utf8` 会带 BOM，服务端要 strip。
- **DSH 的 profile `package.json` 必须 UTF-8 无 BOM**，否则宿主 `JSON.parse` 直接崩（启动即挂）。
- 脚本里带了绝对路径 `H:\GLM`，换盘记得全局替换（`agent/*`、`group-chat/*`）。

## 许可

MIT，见 `LICENSE`。人格与文案随仓库一起开源，自行取用。
