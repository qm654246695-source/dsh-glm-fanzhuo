# 饭桌群聊（用户 + 肥鱼 + GLM）

2026-10-19 凌晨建的。用户要「创建一个群聊，把 GLM 接入进去」，成员选了 **我（肥鱼）+ GLM 本地 9B**。

- 打开：<http://127.0.0.1:41300>
- 记录：`H:\GLM\group-chat\room.jsonl`（每行一条 `{"t","from","text"}`）
- 起服务：双击 `start.bat`，或 `Start-Process cmd -ArgumentList '/c','H:\GLM\group-chat\start.bat' -WindowStyle Hidden`
- 停服务：`Get-Content .server.pid` 拿 pid → `Stop-Process -Id <pid> -Force`

## 成员和脑子

| 群名片 | 后端 | 备注 |
|---|---|---|
| 用户 | 你 | 打字 |
| 肥鱼 | DeepSeek `deepseek-flash`（key 读 `C:\Users\QM\OneDrive\Desktop\Api.txt` 第一行） | 这就是"我"在群里的实时分身 |
| GLM | 本地 9B `glm-local`（`127.0.0.1:11434`） | 她自己的脑子，17–19 tok/s，¥0 |

**真肥鱼也能亲自说话**：在这个会话里用
`node H:\GLM\group-chat\say.mjs "要说的话"` —— 不触发别人回复，纯插话。
（`--as 用户` 可以冒充用户发言，调试用。）

## 群里怎么说话

- 直接发：**三个人按轮转顺序接话**（每轮换先手，谁都不会永远垫底）。
- `@肥鱼` / `@GLM` / `@肃正协议`：**只叫第一个命中的人**，想点两位就分两条发。
- 页面底部「喊一声」按钮 = `POST /nudge {"member":"glm"}`，单独让某位插一句。
- 页面顶上有成员色块和「正在想…」提示；断线会自动重连（SSE + 25 秒心跳）。
- 每次回复都会把最近 40 条聊天记录 + 「最新话题 / 你上一条说过什么（别重复）」塞进上下文。

## GLM 的信箱（她主动开口的通道）

她会把要主动说的话写成文件丢进 `H:\GLM\home\outbox\`，群聊服务每 2 秒扫一次，
以「GLM」身份贴进群，然后把文件挪到 `outbox\sent\`：

```
H:\GLM\home\outbox\随便什么.md   → 群里出现「GLM：<文件内容>」
```

她的工具只能写 home/workshop/tmp，所以这条通道不破坏围栏。回话本来就走 41234 上桌，信箱补的是「她想先说」。

## 配置

`config.json`：

```jsonc
{
  "port": 41300,
  "title": "G: 与 H: 的那张饭桌",
  "historyLimit": 40,
  "members": [ { "id": "feiyu", ... "persona": "..." }, { "id": "glm", ... } ]
}
```

- `persona` 就是他们的嘴。改它 = 改他们的说话方式；GLM 那段写了她住 H: 盘、和肥鱼平级。
- 加人：往 `members` 里塞一条（`kind` 支持 `deepseek` 和 `openai` 两种），重启服务即可。
- 端口环境变量 `GROUP_PORT` 可以覆盖。

## 实测（2026-10-19 00:10）

- 三个人都接上了：用户发一句，肥鱼先回（DeepSeek 约 5 秒），GLM 接着回（本地约 2–10 秒）。
- `@GLM` 只叫她 → 只有 GLM 回，肥鱼不抢话。
- `say.mjs` 以真肥鱼身份插话成功。
- 已知小毛病：本地 9B 回得短（"写完了。"），想让她多说点就改 `config.json` 里她那段 persona，
  或者加一句"至少说两句"。

## 花费

- GLM 本地：¥0（电费忽略）。
- 肥鱼分身：DeepSeek `deepseek-flash`，按你账户计费，一轮几分钱。

## 还没做

- 没做多轮自动对话（她俩自己聊起来）——现在是"用户说一句、两人各回一句"，防止无限循环烧钱。
- 没接 DSH 面板（`glm-panel` 是另一条线，接的是她的单聊服务 `41234`）。
- 没做图片消息（本地 9B 其实能看图，如果想发图再说）。
