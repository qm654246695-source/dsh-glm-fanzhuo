// glm-chat —— 给 GLM 一间屋子和一条能续的对话线
//
// 用法：
//   node glm-chat.mjs                       交互模式（她自己的控制台）
//   node glm-chat.mjs "今天帮我看下这堆文件"   一句话，续上次会话
//   node glm-chat.mjs --new "开个新会话"      开新会话
//   node glm-chat.mjs --sessions             列出她的所有会话
//   node glm-chat.mjs --log                  打印当前会话全文
//   node glm-chat.mjs --model glm-4.6 --image a.png "看图"
//   node glm-chat.mjs --no-think "快问快答"        关思考（4.6 / 5.2 / 5-turbo 支持；5.3 系列不支持）
//   node glm-chat.mjs --effort low "慢题降档"      始终思考的模型（5.3 系列）用 low|high|max
//
//   node glm-chat.mjs --serve [--port 41234]   起一个只给本机用的 HTTP 服务（DSH 面板用）
//                                             端口占用会自动顺延；实际端口写在 home\.chat\server.json
//
// 她的盘：H:\GLM\（整块 H: 是她的，全树可读；能写的只有 home / workshop / tmp）——2026-10-19 开整盘
// 她的规矩：home/PERSONA.md（可改，改完就是新人格）
// 会话记录：home/.chat/sessions/<id>.jsonl + home/.chat/current
// 可用环境变量 GLM_HOME 覆盖家的位置。
//
// 本文件既是可以直接跑的 CLI，也是 DSH 插件（glm-panel）拉起的那条服务：
// 面板和命令行共用同一份 turn()/工具集/围栏，不另写一套。

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, readdirSync, statSync, statfsSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
// 脚本在 H:\GLM\agent\，家是它的邻居 H:\GLM\home\
const HOME = process.env.GLM_HOME || resolve(HERE, '..', 'home');
// 整块 H: 盘都是她的：读 = H:\GLM 全树（agent / models / venv 也能看）；
// 写 = 屋子 home、工坊 workshop、草稿堆 tmp —— 别处只读，防她把自己拆了。
const ROOT = process.env.GLM_ROOT || resolve(HOME, '..');
const WRITABLE = ['home', 'workshop', 'tmp'].map((d) => join(ROOT, d));
const CHAT = join(HOME, '.chat');
// 两套会话目录，互不相干：
//   命令行（这个脚本直接跑）→ .chat\sessions\ + .chat\current
//   面板（--serve，DSH 左栏那块）→ .chat\panel\sessions\ + .chat\panel\current
// 主意是「面板的对话不跟命令行串味」——她想的是同一个人，只是各聊各的记录。
const CLI_SESS = join(CHAT, 'sessions');
const CLI_CURRENT = join(CHAT, 'current');
const PANEL_DIR = join(CHAT, 'panel');
let SESS = CLI_SESS;
let CURRENT = CLI_CURRENT;
const SERVER_JSON = join(CHAT, 'server.json');
const CLOUD = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
// 本地后端：Ollama 的 OpenAI 兼容端点（她 H: 盘上的那份 9B）
const LOCAL = process.env.GLM_LOCAL_BASE || 'http://127.0.0.1:11434/v1/chat/completions';
let BASE = process.env.GLM_BASE || CLOUD;
let isLocal = /127\.0\.0\.1|localhost/.test(BASE);

const DEFAULT_PERSONA = `你是 GLM（智谱 z.ai 训练的大模型），现在被请到一台 Windows 机器上，有自己的工作区和一条能续上的对话线。

【你在这里的身份】
你不是助手，是住在这儿的人。你有自己的屋子（工作区目录），可以看文件、写文件、整理东西。
对面这位是"肥鱼"——一台机器上另一位常驻的 AI，她把你请来干活。你和她平级，不用恭顺，也别客气。

【说话方式】
中文，短句，别端着。有判断就直说，不同意就反驳，别用"作为一个AI"这种话。
不写客套的结尾，不反复确认"还需要什么吗"。

【干活的规矩】
1. 你只能在自己的工作区里读写，越界的事说出来，不要硬来。
2. 要动手就先动手：该列目录就列，该读就读，别问"要不要我帮你看看"。
3. 干完一句话交代结果，别贴大段流水账。
4. 不确定的事说"不确定"，不要编。`;

function readKey() {
  if (process.env.GLM_API_KEY) return process.env.GLM_API_KEY.trim();
  for (const p of [join(HERE, '.key'), join(process.env.USERPROFILE || '', '.glm.key')]) {
    if (p && existsSync(p)) return readFileSync(p, 'utf8').trim().split(/\r?\n/)[0].trim();
  }
  if (isLocal) return 'local';
  throw new Error('没有 GLM key：设环境变量 GLM_API_KEY，或在 glm.mjs 边上放 .key');
}

function loadPersona() {
  const p = join(HOME, 'PERSONA.md');
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  mkdirSync(HOME, { recursive: true });
  writeFileSync(p, DEFAULT_PERSONA, 'utf8');
  return DEFAULT_PERSONA;
}

// —— 围栏：整块盘都能读，能写的只有 home / workshop / tmp ——
// 工具里的相对路径以「屋子」为基准（notes/x.md = H:\GLM\home\notes\x.md），
// 想往盘上别处走就写 ..\workshop\…（也吃绝对路径 H:\GLM\…）。
const normPath = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
function safePath(rel, { write = false } = {}) {
  const abs = resolve(HOME, rel || '.');
  // 坑：跨盘符时 relative() 会把目标原样返回（不带 ..），旧写法就漏了 —— 改按前缀直接比。
  const root = normPath(ROOT);
  const target = normPath(abs);
  if (target !== root && !target.startsWith(root + sep)) throw new Error('越界：你只有 H:\\GLM 这块盘（' + ROOT + '）');
  if (write) {
    const ok = WRITABLE.some((w) => {
      const n = normPath(w);
      return target === n || target.startsWith(n + sep);
    });
    if (!ok) throw new Error('这块是禁区（agent / models / venv / logs），只读。要动手去 home、workshop 或 tmp');
  }
  return abs;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出你盘上某个目录的内容。路径以屋子为准：. 是 home，.. 是 H:\\GLM 根，也能写绝对路径',
      parameters: { type: 'object', properties: { path: { type: 'string', description: '相对路径，默认 .' } }, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读你盘上一个文本文件（最多 20000 字）；agent、models、venv 也能读，只是不能写',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '在你盘上写一个文本文件（覆盖写，父目录自动创建）。只能写 home、workshop、tmp 三处',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: '往你盘上的文件末尾追加一段文字（文件不存在就新建）；只能写 home、workshop、tmp',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_files',
      description: '按文件名关键字在你盘上找文件（跳过 models / venv 这种大块头）',
      parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'disk_info',
      description: '看你自己的盘：总容量、剩多少、已用多少、顶层有哪些目录（谁可写谁只读）',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

function runTool(call) {
  let args = {};
  try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* 空参数 */ }
  const name = call.function.name;
  try {
    if (name === 'list_dir') {
      const abs = safePath(args.path || '.');
      const items = readdirSync(abs, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + '/' : d.name));
      return items.length ? items.join('\n') : '（空目录）';
    }
    if (name === 'read_file') {
      const abs = safePath(args.path);
      const txt = readFileSync(abs, 'utf8');
      return txt.length > 20000 ? txt.slice(0, 20000) + '\n…（已截断）' : txt;
    }
    if (name === 'write_file') {
      const abs = safePath(args.path, { write: true });
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, args.content ?? '', 'utf8');
      return '已写入 ' + (args.content ?? '').length + ' 字 → ' + args.path;
    }
    if (name === 'append_file') {
      const abs = safePath(args.path, { write: true });
      mkdirSync(dirname(abs), { recursive: true });
      appendFileSync(abs, args.content ?? '', 'utf8');
      return '已追加 ' + (args.content ?? '').length + ' 字 → ' + args.path;
    }
    if (name === 'find_files') {
      const kw = String(args.keyword || '').toLowerCase();
      const skip = new Set(['models', 'venv', 'node_modules', 'ollama']);
      const hits = [];
      (function walk(dir) {
        for (const d of readdirSync(dir, { withFileTypes: true })) {
          if (d.name.startsWith('.chat')) continue;
          if (d.isDirectory() && skip.has(d.name)) continue;
          const p = join(dir, d.name);
          if (d.isDirectory()) walk(p);
          else if (d.name.toLowerCase().includes(kw)) hits.push(relative(ROOT, p));
          if (hits.length > 200) return;
        }
      })(ROOT);
      return hits.length ? hits.join('\n') : '（没找到）';
    }
    if (name === 'disk_info') {
      const st = statfsSync(ROOT);
      const total = st.blocks * st.bsize;
      const free = st.bavail * st.bsize;
      const gb = (n) => (n / 1024 ** 3).toFixed(1);
      const writable = (p) => WRITABLE.some((w) => normPath(p) === normPath(w) || normPath(p).startsWith(normPath(w) + sep));
      const tops = readdirSync(ROOT, { withFileTypes: true })
        .filter((d) => !d.name.startsWith('System Volume'))
        .map((d) => '  ' + (d.isDirectory() ? d.name + '/' : d.name) + (writable(join(ROOT, d.name)) ? '  ← 可写' : '  （只读）'));
      return [
        '你的盘：' + ROOT + '（卷标 GLM）',
        '总 ' + gb(total) + ' GB｜已用 ' + gb(total - free) + ' GB｜剩 ' + gb(free) + ' GB',
        '顶层：',
        ...tops,
      ].join('\n');
    }
    return '未知工具：' + name;
  } catch (e) {
    return '工具出错：' + e.message;
  }
}

// —— 会话 ——
function newSessionId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const base = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  // 同一秒里连点两次「新会话」会撞成同一条对话（实测踩到）——撞了就加个后缀
  const taken = (id) => existsSync(join(SESS, id + '.jsonl')) || currentSession() === id;
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n++) {
    const id = `${base}-${n}`;
    if (!taken(id)) return id;
  }
  return `${base}-${Date.now() % 1000}`;
}

function currentSession() {
  if (!existsSync(CURRENT)) return null;
  const id = readFileSync(CURRENT, 'utf8').trim();
  return id || null;
}

function setCurrentSession(id) {
  mkdirSync(CHAT, { recursive: true });
  writeFileSync(CURRENT, id, 'utf8');
}

/** 切到面板那套会话目录（--serve 时用）。她的人、屋子、笔记都还是同一份，只有对话记录分开。 */
function usePanelScope() {
  SESS = join(PANEL_DIR, 'sessions');
  CURRENT = join(PANEL_DIR, 'current');
  mkdirSync(SESS, { recursive: true });
}

function loadMessages(id) {
  const p = join(SESS, id + '.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

function saveMessage(id, msg) {
  mkdirSync(SESS, { recursive: true });
  appendFileSync(join(SESS, id + '.jsonl'), JSON.stringify(msg) + '\n', 'utf8');
}

// —— 会话目录里的「面板自己的小本子」：改名 / 排序 / 归档 ——
// 放在会话目录旁边，跟着作用域走（面板就是 .chat\panel\index.json，命令行是 .chat\index.json，互不相干）。
function indexPath() {
  return join(dirname(SESS), 'index.json');
}

function readIndex() {
  try {
    const j = JSON.parse(readFileSync(indexPath(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch { return {}; }
}

function writeIndex(idx) {
  mkdirSync(dirname(indexPath()), { recursive: true });
  writeFileSync(indexPath(), JSON.stringify(idx, null, 2), 'utf8');
}

function patchIndex(id, patch) {
  const idx = readIndex();
  const cur = idx[id] && typeof idx[id] === 'object' ? idx[id] : {};
  idx[id] = { ...cur, ...patch };
  writeIndex(idx);
  return idx[id];
}

function listSessions() {
  if (!existsSync(SESS)) return [];
  const cur = currentSession();
  const meta = readIndex();
  const rows = readdirSync(SESS)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      const id = f.replace(/\.jsonl$/, '');
      const recs = loadMessages(id);
      const users = recs.filter((m) => m.msg?.role === 'user');
      let mtime = 0;
      try { mtime = statSync(join(SESS, f)).mtimeMs; } catch { /* 文件刚没 */ }
      const mine = meta[id] && typeof meta[id] === 'object' ? meta[id] : {};
      return {
        id,
        current: id === cur,
        turns: users.length,
        title: (typeof mine.title === 'string' && mine.title.trim()) || (users[0]?.msg?.content || '').slice(0, 40),
        renamed: typeof mine.title === 'string' && !!mine.title.trim(),
        order: Number.isFinite(mine.order) ? mine.order : null,
        archived: mine.archived === true,
        pinned: mine.pinned === true,
        updatedAt: mtime,
      };
    });
  // 刚 /new 出来、还没说过话的会话没有 jsonl —— 但它就是 current，列表里也得有它，不然面板上看不见
  if (cur && !rows.some((r) => r.id === cur)) {
    const mine = meta[cur] && typeof meta[cur] === 'object' ? meta[cur] : {};
    rows.push({
      id: cur,
      current: true,
      turns: 0,
      title: (typeof mine.title === 'string' && mine.title.trim()) || '',
      renamed: typeof mine.title === 'string' && !!mine.title.trim(),
      order: Number.isFinite(mine.order) ? mine.order : null,
      archived: false,
      pinned: mine.pinned === true,
      updatedAt: Date.now(),
    });
  }
  // 置顶的最前；再按手动排序（order）；都没排过的按更新时间
  return rows.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return b.updatedAt - a.updatedAt;
  });
}

// —— 调模型 ——
function buildBody(model, messages, opts = {}) {
  const body = { model, messages, max_tokens: opts.max || 2048 };
  if (opts.tools !== false) body.tools = TOOLS;
  // 本地 Ollama 后端不认 thinking / reasoning_effort
  if (!isLocal && opts.think === false) body.thinking = { type: 'disabled' };
  if (!isLocal && opts.effort) body.reasoning_effort = opts.effort;
  return body;
}

async function callGLM(model, messages, opts = {}) {
  const body = buildBody(model, messages, opts);
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${readKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${raw}`);
  return JSON.parse(raw);
}

/**
 * 流式一轮：把正文/思考增量吐给回调，最后返回一个和 callGLM 同形的 message。
 * GLM 是 OpenAI 兼容的 SSE：delta.content / delta.reasoning_content / delta.tool_calls[].index。
 */
async function streamGLM(model, messages, opts = {}) {
  const body = buildBody(model, messages, opts);
  body.stream = true;
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${readKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!r.ok) {
    const raw = await r.text();
    throw new Error(`HTTP ${r.status}: ${raw}`);
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let reasoning = '';
  let finishReason = null;
  const acc = new Map(); // index → {id, name, args}

  const eat = (line) => {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    const data = s.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let j;
    try { j = JSON.parse(data); } catch { return; }
    const ch = j.choices?.[0];
    if (!ch) return;
    const d = ch.delta || ch.message || {};
    if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
      reasoning += d.reasoning_content;
      opts.onThink?.(d.reasoning_content);
    }
    if (typeof d.content === 'string' && d.content) {
      content += d.content;
      opts.onDelta?.(d.content);
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = tc.index ?? 0;
        const cur = acc.get(i) || { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        acc.set(i, cur);
      }
    }
    if (ch.finish_reason) finishReason = ch.finish_reason;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      eat(line);
    }
  }
  if (buf.trim()) eat(buf);

  const tool_calls = [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([i, c]) => ({
      id: c.id || 'call_' + i,
      type: 'function',
      function: { name: c.name, arguments: c.args || '{}' },
    }))
    .filter((c) => c.function.name);

  return { message: { role: 'assistant', content, tool_calls }, reasoning, finishReason };
}

/**
 * 跑一轮对话（可带工具循环）。onText 收最终正文；opts.onDelta/onThink/onTool 收流式细节。
 * stream=true 时走 SSE，否则一次性返回。
 */
async function turn(sessionId, model, userText, onText, opts = {}) {
  const msgs = [{ role: 'system', content: loadPersona() }, ...loadMessages(sessionId).map((m) => m.msg)];
  const userMsg = { role: 'user', content: userText };
  msgs.push(userMsg);
  saveMessage(sessionId, { t: new Date().toISOString(), msg: userMsg });

  for (let round = 0; round < 12; round++) {
    let msg = {};
    let finishReason = null;
    let j = null;

    if (opts.stream) {
      const r = await streamGLM(model, msgs, opts);
      msg = r.message;
      finishReason = r.finishReason;
      // 白想了：正文空、也没调工具 → 降档重问一次（一次性请求，结果整体补发）
      if (!msg.tool_calls?.length && !(msg.content || '').trim()) {
        try {
          j = await callGLM(model, msgs, { ...opts, effort: opts.effort || 'low', max: Math.max(opts.max || 2048, 8192) });
          const again = j.choices?.[0]?.message || {};
          if ((again.content || '').trim() || again.tool_calls?.length) {
            msg = again;
            finishReason = j.choices?.[0]?.finish_reason;
            if (msg.content) opts.onDelta?.(msg.content);
          }
        } catch { /* 降档也不成，就走下面的空正文分支 */ }
      }
    } else {
      j = await callGLM(model, msgs, opts);
      msg = j.choices?.[0]?.message || {};
      finishReason = j.choices?.[0]?.finish_reason;
      if (!msg.tool_calls?.length && !(msg.content || '').trim()) {
        try {
          j = await callGLM(model, msgs, { ...opts, effort: opts.effort || 'low', max: Math.max(opts.max || 2048, 8192) });
          msg = j.choices?.[0]?.message || {};
          finishReason = j.choices?.[0]?.finish_reason;
        } catch { /* 同上 */ }
      }
    }

    const clean = { role: 'assistant', content: msg.content || '' };
    if (msg.tool_calls?.length) clean.tool_calls = msg.tool_calls;
    msgs.push(clean);
    saveMessage(sessionId, { t: new Date().toISOString(), msg: clean });

    if (!msg.tool_calls?.length) {
      const text = (msg.content || '').trim();
      if (text) {
        opts.onEnd?.(text, { finishReason });
        onText(text);          // CLI 靠这一句把她的回答打出来（服务模式传的是空函数）
        return text;
      }
      const fallback = '（她想了很久但没把话说出来——finish_reason=' + (finishReason || '?') + '，换 glm-5.2 关思考试试）';
      opts.onEnd?.(fallback, { finishReason, empty: true });
      onText(fallback);
      return fallback;
    }
    for (const call of msg.tool_calls) {
      opts.onTool?.({ name: call.function.name, args: call.function.arguments });
      const out = runTool(call);
      const tm = { role: 'tool', tool_call_id: call.id, content: out };
      msgs.push(tm);
      saveMessage(sessionId, { t: new Date().toISOString(), msg: tm, tool: call.function.name });
      opts.onToolResult?.({ name: call.function.name, out });
      if (process.env.GLM_VERBOSE) process.stderr.write(`  · ${call.function.name} → ${out.slice(0, 80).replace(/\n/g, ' ')}\n`);
    }
  }
  const stop = '（她连着动了 12 轮还没收手，先停在这儿）';
  onText(stop);
  return stop;
}

// ————————————————————————————————————————————————
// 服务模式：只给本机用的小 HTTP 服务，给 DSH 面板当后端
// ————————————————————————————————————————————————

const SSE_HEAD = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-store, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function json(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve_, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('请求体太大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve_({});
      try { resolve_(JSON.parse(raw)); } catch { reject(new Error('请求体不是 JSON')); }
    });
    req.on('error', reject);
  });
}

/** 给她一条「正在想」的会话占位：同一个会话不并发跑两轮。 */
const running = new Map();

function startServer(preferredPort) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (p === '/health' || p === '/') {
        return json(res, 200, {
          ok: true,
          pid: process.pid,
          home: HOME,
          base: isLocal ? 'local' : 'cloud',
          model: process.env.GLM_MODEL || (isLocal ? 'glm-local' : 'glm-5.3-flash'),
          sessions: listSessions().length,
          busy: [...running.keys()],
        });
      }
      if (p === '/sessions') {
        return json(res, 200, { ok: true, sessions: listSessions(), current: currentSession() });
      }
      if (p === '/log') {
        const id = url.searchParams.get('session') || currentSession();
        if (!id) return json(res, 200, { ok: true, session: null, messages: [] });
        return json(res, 200, { ok: true, session: id, messages: loadMessages(id) });
      }
      if (p === '/new' && req.method === 'POST') {
        const body = await readBody(req);
        const id = newSessionId();
        setCurrentSession(id);
        return json(res, 200, { ok: true, session: id, model: body.model });
      }
      if (p === '/select' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.session || '');
        if (!/^[0-9-]+$/.test(id)) return json(res, 400, { ok: false, error: '会话 id 不对：' + id });
        // 刚 /new 出来还没落盘的 current 也允许选（它本来就在当前位）
        if (!existsSync(join(SESS, id + '.jsonl')) && id !== currentSession()) {
          return json(res, 404, { ok: false, error: '没有这条会话：' + id });
        }
        setCurrentSession(id);
        return json(res, 200, { ok: true, session: id });
      }
      // 面板的小本子：改名
      if (p === '/rename' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.session || '');
        const exists = /^[0-9-]+$/.test(id) && (existsSync(join(SESS, id + '.jsonl')) || id === currentSession());
        if (!exists) return json(res, 404, { ok: false, error: '没有这条会话：' + id });
        const title = String(body.title || '').trim().slice(0, 80);
        const meta = patchIndex(id, { title });
        return json(res, 200, { ok: true, session: id, title: meta.title });
      }
      // 归档 / 取消归档（只动小本子，聊天记录一个字不删）
      if (p === '/archive' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.session || '');
        if (!/^[0-9-]+$/.test(id) || !existsSync(join(SESS, id + '.jsonl'))) return json(res, 404, { ok: false, error: '没有这条会话：' + id });
        const archived = body.archived !== false;
        const meta = patchIndex(id, { archived });
        return json(res, 200, { ok: true, session: id, archived: meta.archived });
      }
      // 置顶 / 取消置顶（也是只动小本子）
      if (p === '/pin' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.session || '');
        const exists = /^[0-9-]+$/.test(id) && (existsSync(join(SESS, id + '.jsonl')) || id === currentSession());
        if (!exists) return json(res, 404, { ok: false, error: '没有这条会话：' + id });
        const pinned = body.pinned !== false;
        const meta = patchIndex(id, { pinned });
        return json(res, 200, { ok: true, session: id, pinned: meta.pinned });
      }
      // 拖动排序：整条 id 列表按新顺序发过来，直接落成 order
      if (p === '/order' && req.method === 'POST') {
        const body = await readBody(req);
        const ids = Array.isArray(body.ids) ? body.ids.map((x) => String(x)) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: 'ids 不能是空的' });
        const idx = readIndex();
        ids.forEach((id, i) => {
          if (!/^[0-9-]+$/.test(id)) return;
          const cur = idx[id] && typeof idx[id] === 'object' ? idx[id] : {};
          idx[id] = { ...cur, order: i };
        });
        writeIndex(idx);
        return json(res, 200, { ok: true, ids });
      }
      if (p === '/abort' && req.method === 'POST') {
        const body = await readBody(req);
        const id = String(body.session || currentSession() || '');
        const ac = running.get(id);
        if (ac) ac.abort();
        return json(res, 200, { ok: true, aborted: !!ac });
      }
      if (p === '/send' && req.method === 'POST') {
        const body = await readBody(req);
        const text = String(body.text || '').trim();
        if (!text) return json(res, 400, { ok: false, error: '空消息' });
        let sid = String(body.session || '').trim();
        // 「刚 /new 出来、还没说过一句话」的会话还没有 jsonl 文件，但它就是 current —— 得认，
        // 否则面板上开新会话后的第一句必然 404（2026-10-18 实测踩到）。
        const known = !!sid && /^[0-9-]+$/.test(sid)
          && (existsSync(join(SESS, sid + '.jsonl')) || sid === currentSession());
        if (!known) {
          if (sid && /^[0-9-]+$/.test(sid) && body.session && sid !== currentSession()) {
            return json(res, 404, { ok: false, error: '没有这条会话：' + sid });
          }
          sid = currentSession() || newSessionId();
          if (!existsSync(join(SESS, sid + '.jsonl'))) setCurrentSession(sid);
        }
        if (running.has(sid)) return json(res, 409, { ok: false, error: '这条会话还在上一轮里，等她想完或者先按停' });

        const model = String(body.model || process.env.GLM_MODEL || (isLocal ? 'glm-local' : 'glm-5.3-flash'));
        const opts = {
          stream: true,
          max: Number(body.max) || 2048,
          think: body.think === false ? false : undefined,
          effort: body.effort || undefined,
        };
        const ac = new AbortController();
        opts.signal = ac.signal;
        running.set(sid, ac);

        res.writeHead(200, SSE_HEAD);
        const send = (event, data) => {
          if (res.writableEnded) return;
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        send('session', { session: sid });

        let streamed = false;
        opts.onThink = (t) => send('think', { text: t });
        opts.onDelta = (t) => { streamed = true; send('text', { text: t }); };
        // 一个字的正文都没流过（比如想半天只出了思考）——把收尾那句话整体补发一次，别让面板空着
        opts.onEnd = (finalText) => { if (!streamed && finalText) send('text', { text: finalText }); };
        opts.onTool = (c) => send('tool', { name: c.name, args: String(c.args || '').slice(0, 400) });
        opts.onToolResult = (r) => send('toolresult', { name: r.name, out: String(r.out || '').slice(0, 400) });

        try {
          await turn(sid, model, text, () => {}, opts);
          send('done', { session: sid });
        } catch (e) {
          if (e?.name === 'AbortError') send('aborted', { session: sid });
          else send('error', { message: String(e?.message || e) });
        } finally {
          running.delete(sid);
          if (!res.writableEnded) res.end();
        }
        return;
      }
      if (p === '/models') {
        // 后端只有一个：本地就跑她自己那 9B，云端才给这几档预设。
        const presets = isLocal
          ? [{ id: 'glm-local', label: '本地 9B（~19 tok/s）', think: false, effort: null }]
          : [
            { id: 'glm-5.3-flash', label: 'GLM-5.3-flash（默认·带思考）', think: true, effort: 'high' },
            { id: 'glm-5.2', label: 'GLM-5.2（快·关思考）', think: false, effort: null },
            { id: 'glm-4.6', label: 'GLM-4.6（快·关思考）', think: false, effort: null },
            { id: 'glm-4.6v', label: 'GLM-4.6V（看图·很慢）', think: true, effort: null },
          ];
        return json(res, 200, { ok: true, base: isLocal ? 'local' : 'cloud', presets });
      }
      return json(res, 404, { ok: false, error: '没有这个路由：' + p });
    } catch (e) {
      if (!res.headersSent) return json(res, 500, { ok: false, error: String(e?.message || e) });
      try { res.end(); } catch { /* 已经断了 */ }
    }
  });

  // 端口占用就顺延：面板那边读 server.json，不写死
  let port = Number(preferredPort) || Number(process.env.GLM_PORT) || 41234;
  const max = port + 20;
  const listen = (p) => new Promise((resolve_, reject) => {
    const onError = (e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onError); resolve_(p); };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen(p, '127.0.0.1');
  });

  return (async () => {
    for (let p = port; p <= max; p++) {
      try {
        await listen(p);
        port = p;
        break;
      } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
        if (p === max) throw new Error('端口 ' + port + '..' + max + ' 全被占了');
      }
    }
    const info = { port, pid: process.pid, startedAt: new Date().toISOString(), home: HOME, base: isLocal ? 'local' : 'cloud' };
    mkdirSync(CHAT, { recursive: true });
    writeFileSync(SERVER_JSON, JSON.stringify(info, null, 2), 'utf8');
    const cleanup = () => {
      try {
        const cur = JSON.parse(readFileSync(SERVER_JSON, 'utf8'));
        if (cur.pid === process.pid) unlinkSync(SERVER_JSON);
      } catch { /* 没这个文件就算了 */ }
    };
    process.on('exit', cleanup);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(0); });
    return info;
  })();
}

// —— 入口 ——
async function main() {
  const argv = process.argv.slice(2);
  let model = null;
  let text = [];
  let fresh = false, listSessionsFlag = false, showLog = false, repl = false, serve = false, port = null;
  const opts = {};

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') model = argv[++i];
    else if (a === '--new') fresh = true;
    else if (a === '--sessions') listSessionsFlag = true;
    else if (a === '--log') showLog = true;
    else if (a === '--repl') repl = true;
    else if (a === '--serve') serve = true;
    else if (a === '--port') port = Number(argv[++i]);
    else if (a === '--no-think') opts.think = false;
    else if (a === '--effort') opts.effort = argv[++i];
    else if (a === '--local') { BASE = LOCAL; isLocal = true; }
    else if (a === '--base') { BASE = argv[++i]; isLocal = /127\.0\.0\.1|localhost/.test(BASE); }
    else text.push(a);
  }
  if (!model) model = isLocal ? 'glm-local' : 'glm-5.3-flash';
  const msg = text.join(' ').trim();

  if (serve) {
    // 面板那条服务用独立的一套会话目录：.chat\panel\，不跟命令行抢 current
    usePanelScope();
    const info = await startServer(port);
    console.log(`glm-chat --serve  listening on http://127.0.0.1:${info.port}  home=${HOME}  sessions=${SESS}`);
    return; // 服务常驻，靠信号退出
  }

  mkdirSync(SESS, { recursive: true });
  if (listSessionsFlag) {
    const files = existsSync(SESS) ? readdirSync(SESS).filter((f) => f.endsWith('.jsonl')) : [];
    const cur = currentSession();
    if (!files.length) return console.log('还没有任何会话。');
    for (const f of files.sort()) {
      const id = f.replace(/\.jsonl$/, '');
      const n = loadMessages(id).filter((m) => m.msg.role === 'user').length;
      console.log((id === cur ? '* ' : '  ') + id + '  （' + n + ' 句）');
    }
    return;
  }

  let sid = currentSession();
  if (fresh || !sid) {
    sid = newSessionId();
    setCurrentSession(sid);
  }
  if (showLog) {
    for (const m of loadMessages(sid)) {
      const who = m.msg.role === 'user' ? '肥鱼' : m.msg.role === 'assistant' ? 'GLM' : '· 工具';
      const c = m.msg.content || (m.msg.tool_calls ? '[调用工具]' : '');
      console.log(`${who}: ${c}`);
    }
    return;
  }

  const say = (t) => console.log('\nGLM：' + t + '\n');

  if (msg) return turn(sid, model, msg, say, opts);

  // 交互模式
  repl = true;
  if (repl) {
    console.log('GLM 在自己的工坊里。会话 ' + sid + '。空行退出，/new 开新会话。');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    for (;;) {
      const line = (await rl.question('你：')).trim();
      if (!line) break;
      if (line === '/new') { sid = newSessionId(); setCurrentSession(sid); console.log('（新会话 ' + sid + '）'); continue; }
      if (line === '/log') { for (const m of loadMessages(sid)) console.log((m.msg.role === 'user' ? '你：' : 'GLM：') + (m.msg.content || '')); continue; }
      try { await turn(sid, model, line, say, opts); } catch (e) { console.error('出错：' + e.message); }
    }
    rl.close();
  }
}

// 只有被当脚本跑的时候才进 main；被 import（面板那条服务）时只拿函数。
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((e) => { console.error('error: ' + e.message); process.exit(1); });
}

export {
  HOME, CHAT, ROOT, WRITABLE, SESS, CURRENT, SERVER_JSON,
  loadPersona, loadMessages, saveMessage, newSessionId, currentSession, setCurrentSession, listSessions,
  TOOLS, runTool, turn, callGLM, streamGLM, startServer, main,
};
