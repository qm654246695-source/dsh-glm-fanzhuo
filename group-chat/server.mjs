// 群聊服务：用户 + 肥鱼（DeepSeek）+ GLM（本地 9B）
// 零依赖，只跑在本机。启动：node server.mjs
// 端口默认 41300；房间记录写 room.jsonl（每行一条 {"t","from","text"}）
//
// 路由：
//   GET  /              聊天页面
//   GET  /events        SSE 推送（先推最近 200 条，再推新消息）
//   GET  /history       历史消息 JSON
//   POST /say           {text}          用户说话 → 自动触发成员回复
//   POST /as            {name,text}     以某个成员身份插一句话（不触发展开）
//   GET  /state         {members, online}

import { createServer } from 'node:http';
import { readFileSync, appendFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(readFileSync(join(HERE, 'config.json'), 'utf8'));
const ROOM = join(HERE, 'room.jsonl');
const API_TXT = 'C:\\Users\\QM\\OneDrive\\Desktop\\Api.txt';
const LIMIT = CONFIG.historyLimit || 40;
const MEMBERS = CONFIG.members;
const PORT = Number(process.env.GROUP_PORT || CONFIG.port || 41300);

// —— 消息 ——
function loadRoom() {
  if (!existsSync(ROOM)) return [];
  return readFileSync(ROOM, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}
function say(from, text, extra = {}) {
  const m = { t: new Date().toISOString(), from, text: String(text || '').trim(), ...extra };
  if (!m.text) return null;
  appendFileSync(ROOM, JSON.stringify(m) + '\n', 'utf8');
  for (const res of clients) sse(res, 'msg', m);
  return m;
}

// —— SSE ——
const clients = new Set();
function sse(res, event, data) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// —— 模型调用 ——
function deepseekKey() {
  const raw = readFileSync(API_TXT, 'utf8').split(/\r?\n/)[0] || '';
  return raw.replace(/[^\x20-\x7E]/g, '').trim();
}

async function ask(member, messages) {
  if (member.kind === 'deepseek') {
    const r = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + deepseekKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: member.model || 'deepseek-flash', messages, max_tokens: 700, temperature: 1.0 }),
      signal: AbortSignal.timeout(120000),
    });
    const raw = await r.text();
    if (!r.ok) throw new Error(`deepseek HTTP ${r.status}: ${raw.slice(0, 160)}`);
    return (JSON.parse(raw).choices?.[0]?.message?.content || '').trim();
  }

  // glmserve：走她带工具的那条服务（glm-chat.mjs --serve），用一条**专用会话**，
  // 这样她在群里说「改好了」是真能落纸的，而不会和面板当前那条会话搅在一起。
  if (member.kind === 'glmserve') {
    const endpoint = member.endpoint || 'http://127.0.0.1:41234/send';
    const prompt = messages[messages.length - 1]?.content || '';
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: 'Bearer local', 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: prompt, session: member.session, think: false, route: member.route || 'auto' }),
        signal: AbortSignal.timeout(300000),
      });
      const raw = await r.text();
      if (!r.ok) throw new Error(`serve HTTP ${r.status}: ${raw.slice(0, 160)}`);
      // SSE：只收 event: text 的片段（event: think 是思考，别混进正文）
      let out = '';
      let evt = '';
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event: ')) { evt = line.slice(7).trim(); continue; }
        if (!line.startsWith('data: ')) continue;
        if (evt !== 'text') continue;
        try {
          const j = JSON.parse(line.slice(6));
          if (typeof j.text === 'string') out += j.text;
        } catch { /* 忽略 */ }
      }
      if (out.trim()) return out.trim();
      throw new Error('serve 没有返回正文（可能只出了思考）');
    } catch (e) {
      // serve 不在或出错 → 退回直连 11434 的纯文本，至少还能说话
      if (process.env.GROUP_DEBUG) console.error('[glmserve fallback]', e.message);
      member = { ...member, kind: 'openai', base: member.fallbackBase || 'http://127.0.0.1:11434/v1/chat/completions' };
    }
  }

  // openai 兼容（本地 9B）
  const r = await fetch(member.base, {
    method: 'POST',
    headers: { Authorization: 'Bearer local', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: member.model || 'glm-local',
      messages,
      max_tokens: 700,
      enable_thinking: false,
      temperature: 0.7,
    }),
    signal: AbortSignal.timeout(180000),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`local HTTP ${r.status}: ${raw.slice(0, 160)}`);
  return (JSON.parse(raw).choices?.[0]?.message?.content || '').trim();
}

function transcript(member, room) {
  const msgs = [{ role: 'system', content: member.persona }];
  // 走本地 9B 时只带很少几条：它扛不动长转录（2026-10-21 实测会超时）
  const lim = member.route === 'local' ? 12 : LIMIT;
  const recent = room.slice(-lim);
  const lines = recent.map((m) => `${m.from}：${m.text}`).join('\n');
  const lastUser = [...recent].reverse().find((m) => m.from === '用户' || m.from === '青秒');
  const ownLast = [...recent].reverse().find((m) => m.from === member.name);
  msgs.push({
    role: 'user',
    content: `以下是群聊最近的记录（按时间顺序）：\n${lines}\n\n` +
      `最新话题（用户说的）：${lastUser ? lastUser.text : '（还没有新话题）'}\n` +
      (ownLast ? `你上一条说的是：${ownLast.text.slice(0, 120)}\n` : '') +
      `现在轮到你（${member.name}）说话：针对最新话题说一两三句，**不要重复你上一条的原句**（例如别再说"没做"）。` +
      `只输出你要说的话，别写名字前缀，别替别人说话。`,
  });
  return msgs;
}

let busy = false;
let turnIndex = 0;   // 发言顺序轮转：不让固定某一位永远垫底
async function respondAll(trigger) {
  if (busy) return;
  busy = true;
  try {
    // 每轮把起点往后挪一格：肥鱼→肃正→GLM，下一轮 肃正→GLM→肥鱼……
    const order = MEMBERS.map((_, i) => MEMBERS[(i + turnIndex) % MEMBERS.length]);
    for (const m of order) {
      if (m.id === 'feiyu' && trigger.skipFat) continue;
      if (trigger.only && trigger.only !== m.name && trigger.only !== m.id) continue;
      for (const res of clients) sse(res, 'thinking', { id: m.id, name: m.name });
      try {
        const text = await ask(m, transcript(m, loadRoom()));
        if (text) say(m.name, text);
      } catch (e) {
        say('系统', `${m.name} 没接上话：${String(e.message || e).slice(0, 200)}`);
      }
      for (const res of clients) sse(res, 'idle', { id: m.id });
    }
    if (!trigger.only) turnIndex = (turnIndex + 1) % MEMBERS.length;
  } finally {
    busy = false;
  }
}

// 单独喊某一位插一句（页面上的「喊一声」按钮用；不影响别人）
async function nudge(memberIdOrName) {
  if (busy) return { ok: false, error: '正在有人说话，稍等' };
  const m = MEMBERS.find((x) => x.id === memberIdOrName || x.name === memberIdOrName);
  if (!m) return { ok: false, error: '没有这个成员：' + memberIdOrName };
  busy = true;
  try {
    for (const res of clients) sse(res, 'thinking', { id: m.id, name: m.name });
    const text = await ask(m, transcript(m, loadRoom()));
    if (text) say(m.name, text);
    for (const res of clients) sse(res, 'idle', { id: m.id });
    return { ok: true, member: m.name };
  } catch (e) {
    say('系统', `${m.name} 没接上话：${String(e.message || e).slice(0, 200)}`);
    return { ok: false, error: String(e.message || e) };
  } finally {
    busy = false;
  }
}

// —— 简单路由 ——
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      b = b.replace(/^\uFEFF/, '');            // 有些编辑器/PS 会带 BOM，JSON.parse 会炸
      try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = readFileSync(join(HERE, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('retry: 3000\n\n');
      const room = loadRoom().slice(-200);
      for (const m of room) sse(res, 'msg', m);
      clients.add(res);
      const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
      return;
    }
    if (req.method === 'GET' && p === '/history') return json(res, 200, { ok: true, room: loadRoom().slice(-200) });
    if (req.method === 'GET' && p === '/state') {
      return json(res, 200, {
        ok: true, title: CONFIG.title, busy,
        members: MEMBERS.map((m) => ({ id: m.id, name: m.name, color: m.color, kind: m.kind, model: m.model })),
      });
    }
    if (req.method === 'POST' && p === '/nudge') {
      const body = await readBody(req);
      const who = String(body.member || body.name || '').trim();
      const r = await nudge(who);
      return json(res, r.ok ? 200 : 409, r);
    }
    if (req.method === 'POST' && p === '/say') {
      const body = await readBody(req);
      const text = String(body.text || '').trim();
      if (!text) return json(res, 400, { ok: false, error: '空消息' });
      const named = MEMBERS.find((m) => text.includes('@' + m.name));
      // from 可选：让"真肥鱼"也能带着 @ 说话并触发回复（默认仍是 用户）
      const from = String(body.from || '用户').trim() || '用户';
      const m = say(from, text);
      respondAll({ only: named ? named.name : null }); // 不 await，SSE 里实时看
      return json(res, 200, { ok: true, msg: m });
    }
    if (req.method === 'POST' && p === '/as') {
      const body = await readBody(req);
      const m = say(String(body.name || '肥鱼'), body.text);
      return json(res, 200, { ok: !!m, msg: m });
    }
    return json(res, 404, { ok: false, error: '没有这个路由' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { ok: false, error: String(e?.message || e) });
  }
});

writeFileSync(join(HERE, '.server.pid'), String(process.pid), 'utf8');

// ── 信箱：GLM 往 home\outbox\ 里丢 .md，这里替她贴上饭桌 ─────────────────────
// 她手够不着 room.jsonl、也发不了 HTTP，但 home 下她可写。约定：
//   H:\GLM\home\outbox\*.md  → 以「GLM」身份贴进群 → 处理完挪到 outbox\sent\
const OUTBOX = process.env.GLM_OUTBOX || 'H:\\GLM\\home\\outbox';
const SENT = join(OUTBOX, 'sent');
function pickupOutbox() {
  try {
    if (!existsSync(OUTBOX)) return;
    for (const name of readdirSync(OUTBOX)) {
      const p = join(OUTBOX, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (!st.isFile()) continue;
      if (!/\.(md|txt)$/i.test(name)) continue;
      if (Date.now() - st.mtimeMs < 1200) continue;   // 刚写的先别抢
      let text = '';
      try { text = readFileSync(p, 'utf8').trim(); } catch { continue; }
      try { mkdirSync(SENT, { recursive: true }); renameSync(p, join(SENT, name)); } catch { /* 挪不动就下次 */ }
      if (!text) continue;
      say('GLM', text);
      console.log(`[outbox] 贴上一条：${name}（${text.length} 字）`);
    }
  } catch (e) {
    console.log('[outbox] 出错：' + String(e && e.message || e));
  }
}
setInterval(pickupOutbox, 2000);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`群聊已起： http://127.0.0.1:${PORT}   成员：${MEMBERS.map((m) => m.name).join(' / ')}`);
  try { mkdirSync(SENT, { recursive: true }); console.log(`[outbox] 信箱：${OUTBOX}`); } catch (e) { console.log('[outbox] 建目录失败：' + String(e && e.message || e)); }
});
