# glm-panel —— 把 GLM 装进 DSH 左边栏

> 2026-10-18 晚做。来自 `F:\DSH\交接-给F盘DSH-GLM侧边栏面板.md` 那件活（方案 A 实现了）。

左边栏一排全局图标里多一个 GLM，点开是一块聊天面板：能发、能收流、工具调用折成一行小字，
刷新后历史还在。她就住在 `H:\GLM\`，这个插件只是个插头。

## 长什么样

```
左边栏 (sidebar.panellist)          主面板 (main: key "glm")
  [插件] [日程] [GLM]  ← 点这个  →   ┌──────────────────────────────┐
                                    │ GLM · 会话▾ · 模型▾ · 新会话   │
                                    │  你：列一下 notes              │
                                    │  · list_dir {"path":"notes"}  │
                                    │  ↳ 搬家记录.md 盘点.md         │
                                    │  她：目录里有两个文件…          │
                                    │  ┌──────────────────────┐ 发 │
                                    └──────────────────────────────┘
```

## 结构（为什么这么分）

| 文件 | 干什么 |
|---|---|
| `index.js` | **宿主半**：把 `H:\GLM\agent\glm-chat.mjs --serve` 拉起来看着它，并在 DSH 的 Web 服务上挂 `/glm-panel/api/*` 转发路由 |
| `client.js` | **客户端半**：`window.__ModuleLoader__` 的懒加载工厂，注册侧边栏图标 + `main` 面板 + 全部界面 |
| `cordis.patch.yml` | 只插一行插件本体 |
| `_install/` | DSH 关着的时候用的安装脚本（见下） |

几条硬规矩，别踩：

- **不碰 provider、不碰 agent 会话、不注册工具。** GLM 的脑子在 `H:\GLM\`，这个插件只是路由 + UI。
  宿主只认内置三家 provider，自己写 = 动 plugin 树 = 这台机器上有过三次「启动即崩」。
- **同源转发**，不让浏览器直连她那个动态端口：宿主半读 `home\.chat\server.json` 拿到端口再转，
  面板只 `fetch('/glm-panel/api/...')`，没有跨域、也不暴露端口。
- **同一个会话不并发**：她的服务对同一 session 的第二次 `/send` 直接 409，界面上按「停」会发 `/abort`。
- 界面只用 `--dsw-alias-*` 主题 token，跟随宿主深浅色；文案走 `ctx.locale`（中/英）。

## 装

**现状（2026-10-18 夜）：已经装上了。** profile `package.json` 里有
`"glm-panel": "file:F:/DSH/glm-panel"`，bundles 里也有它；宿主路由与客户端槽位都验过是活的。

正常情况下用 `plugin_manager`（装 bundle），但 **DSH 运行时会把 profile 的 `package.json` / `cordis.patch.yml` 攥住**，
写它们会 `EBUSY`/`EPERM`（pnpm 也写不进）。那个锁可能是临时的（过一次就自己松了），实在装不动再：

1. **推荐**：关掉 DSH → 重新打开 → 让 AI 跑 `plugin_manager install_bundle F:\DSH\glm-panel`
   （冷启动后的实例没有残留的锁）。
2. **兜底**：双击 `install-to-DSH.cmd`。它会等你关掉 DSH，然后自己
   - 在 `profiles\desktop\node_modules\glm-panel` 建一个指到本目录的 junction，
   - 把 `glm-panel` 写进 profile `package.json` 的 `dependencies` 和 `dsh.profile.bundles`，
   - 备份 `package.json.bak-before-glm-panel-<时间戳>`，
   - 最后把 DSH 重新打开。

装完左边栏就有图标了。第一次点开会自己起服务（约 1–2 秒），起好后图标点开就能直接发。

### 改完代码之后

`file:` 依赖是**拷一份**进 `profiles\desktop\node_modules\glm-panel`（不是 junction），
所以在 `F:\DSH\glm-panel` 里改完要同步过去才生效：

```powershell
# 改完把改的文件拷进 profile 里那份
Copy-Item F:\DSH\glm-panel\client.js C:\Users\QM\.dsh\profiles\desktop\node_modules\glm-panel\client.js -Force
```

- 只改 `client.js`：拷完**刷新一下页面**（Ctrl+R）就生效，不用重启。
- 改 `index.js`（宿主半）：拷完要重开 DSH。

## 卸（回滚）

1. 关 DSH。
2. 删 `C:\Users\QM\.dsh\profiles\desktop\node_modules\glm-panel`（**是拷进来的目录，删之前确认它不是你源码那份** ——
   曾经因为把源码目录做成 junction、又对着链接 `rm -r`，把源码删光过一次）。
3. 从 profile `package.json` 里删掉 `dependencies.glm-panel` 和 `dsh.profile.bundles` 里的 `"glm-panel"`；
   或者直接把最新的 `package.json.bak-before-glm-panel-*` 覆盖回去。
4. 想更干净就 `pnpm install` 一次清孤儿目录（可选）。
5. 重开 DSH。插件没了，`H:\GLM\` 一点没动，她的 CLI 照常能用。

`H:\GLM\agent\glm-chat.mjs` 只是多了 `--serve`（和修了一个越界围栏的洞），
回滚这一处就 `Copy-Item glm-chat.mjs.bak-before-serve-20261018 glm-chat.mjs`。

## 后端：云端还是本机 9B

面板的对话可以直接跑在 `H:\GLM` 里那套**本地 9B** 上（免费、离线、约 19 tok/s），也可以走智谱云端。
**面板顶部那个 `本地` / `云端` 徽标就是开关**：点一下就在两边切，当前什么后端就显示什么。

底层开关是一个文件（面板上的点击就是在改它）：

```
H:\GLM\home\.chat\backend     内容 'local' 或 'cloud'（缺省 cloud）
```

- 点徽标会 `POST /glm-panel/backend {mode}`：写文件 → 杀掉 serve 子进程 → 按新后端重拉，约 2–3 秒。
  目标是本地但 11434 没起来时**不会硬切**，返回一句人话提示，继续用云端。
- 环境变量 `GLM_PANEL_BASE` 优先于这个文件（方便临时试）。
- 宿主半**拉起服务前**会先探 `127.0.0.1:11434`；要 local 但本地没起来，就退回 cloud，
  并在 `home\.chat\serve.log` 里留一句「本地后端没响应，这次先用 cloud」。
- 之后每 30 秒复查一次：本地起来了会自动切过去（杀掉子进程重拉，不用重启 DSH）。
- 本地模式下模型下拉只有一个 `glm-local`，云端才有 5.3-flash / 5.2 / 4.6 / 4.6V 那几档。
- 起本地服务：`H:\GLM\agent\start-local-glm.bat`（加载约 30 秒，显存 6.7 GiB）。
  **要在资源管理器里双击它**——从 AI 的 shell 里起的话，它落在 DSH 的作业树里，DSH 一重启就跟着没了。
- 坑（2026-10-19 修）：配置要 local 但 11434 没起来时，旧逻辑会「杀掉云端 → 拉起又判不合规 → 再杀」死循环，
  一分钟内拉起杀掉八次、还在 41234–41237 留下残留进程。现在的 `desiredMode()` 先算「实际可用的后端」，
  只有目标后端确实可达时才换人。残留进程用 `taskkill /PID` 清。

也可以手改文件（改完等 30 秒或重启 DSH）。

## 会话是隔离的（面板 ≠ 命令行）

她想的是同一个人（同一份人格、屋子、笔记），但**对话记录分两套**，互不串：

| 入口 | 会话目录 | 当前会话指针 |
|---|---|---|
| DSH 左栏面板（`--serve`） | `home\.chat\panel\sessions\*.jsonl` | `home\.chat\panel\current` |
| 命令行 `glm-chat.mjs` | `home\.chat\sessions\*.jsonl` | `home\.chat\current` |

- 面板里开新会话、发消息，改的是 `panel\` 那套的 current，不会把命令行的 current 挪走。
- 命令行 `--sessions` / `--log` / `--new` 只看得到自己那一套；面板左侧列表也只看得到面板自己的。
- 切分点在 `glm-chat.mjs` 的 `usePanelScope()`：`--serve` 进来就换目录，别的什么都不变。
- 2026-10-19 之前的旧会话都在**命令行**那套里（面板从空白开始）。

## 对话列表（面板左侧那一列）

面板改成左右两栏：左边是**对话列表**，右边是聊天。

- **点一下**切到那条对话；**双击**改名（回车提交、Esc 取消）。
- **拖动**换顺序（松手就落盘，重开还在）；顺序存在 `home\.chat\panel\index.json`。
- **置顶**：悬停行尾的 `⇡`（已置顶显示成亮色的 `⇧`），置顶的一律排最前，再按手动顺序。
- **悬停**出现 `⊟` 把这条**归档**，收进底部的「已归档 (n)」里；归档里点 `↺` 恢复。
  归档只动 `index.json` 的标记，`sessions\*.jsonl` 一个字都不删。
- 刚点「新会话」还没说话的那条也会出现在列表里（turns=0），能改名、能归档。
- 服务端路由：`POST /rename`（`{session,title}`）、`POST /archive`（`{session,archived}`）、
  `POST /pin`（`{session,pinned}`）、`POST /order`（`{ids:[...]}`）；
  `/sessions` 每条多返回 `renamed` / `order` / `archived` / `pinned`。

## 排错

- 面板点开一片空白 / 一直「连接中」：开 `http://127.0.0.1:<GUI端口>/glm-panel/diag`，
  它给出 agent 路径、服务端口、进程号、最近 25 行服务日志（含 `[err]`/`[exit]`）。
- 服务起不来：看 `H:\GLM\home\.chat\serve.log`。最常见是 key 没了（`H:\GLM\agent\.key`）或 node 不在 PATH。
- 端口被占：自动顺延（41234 → 41254），实际端口看 `home\.chat\server.json`。
- GUI 端口不固定（见过 19387/52298/51072）：读当轮 runtime context 或 `DSH_WEB_URL`，别照抄。
- 回复很慢/常空：GLM 是思考型模型，5.3 系列给多少 token 就往 reasoning 里烧。
  面板右上角模型下拉里选 `5.2 快`（关思考，秒回）最省心；看图才用 `4.6V`（很慢）。

## 她那边多了什么

`H:\GLM\agent\glm-chat.mjs`：

- `--serve [--port N]`：本机 HTTP 服务，路由 `/health` `/sessions` `/log` `/new` `/select` `/send`（SSE）`/abort` `/models`；
  端口占用自动顺延，实际端口写 `home\.chat\server.json`，退出时删掉它。
- `turn()` 支持流式（`onDelta` / `onThink` / `onTool` / `onToolResult` / `onEnd`），CLI 行为不变。
- 脚本改成可被 `import`（`main()` 只在直接运行时跑），面板和 CLI 共用同一份工具集与围栏。
- **顺手修了围栏的洞**：原来 `safePath` 用 `path.relative()` 判越界，跨盘符时 `relative()` 会原样返回目标路径
  （不带 `..`），于是 `read_file "D:\x"` 能溜出去。现在改成按 `HOME` 前缀直接比。
