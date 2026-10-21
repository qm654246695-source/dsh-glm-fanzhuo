// glm-panel —— 把 GLM 的对话搬进 DSH 左边栏
//
// 两半：
//   · 宿主半（本文件）：在 DSH 的 Web 服务上挂一条 /glm-panel/api/* 的转发路由，
//     并且负责把 H:\GLM\agent\glm-chat.mjs --serve 那条本机服务拉起来、看着它别死。
//   · 客户端半（client.js）：侧边栏一个图标 + 一块聊天面板，走同一条 HTTP 路由。
//
// 为什么不直接把 GLM 做成 provider 插件：见 H:\GLM\交接.md —— 宿主只认内置的三家
// provider，自己写 = 动 plugin 树 = 有把 DSH 搞得起不来的前科。这里只挂路由和一段 UI，
// 不碰 provider、不碰 agent 会话。
//
// 设计取舍：GLM 的脑子、屋子、围栏、工具全在 H:\GLM\ 里，这里一行不搬。
// 这个插件只是个「插头」：拉起她、转发请求、把她的流原样吐给浏览器。

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { request as httpRequest } from 'node:http';

export const name = 'glm-panel';
// 不硬依赖任何服务：webServer 用 ctx.inject 可选挂，缺了就是插件不激活，不会拖垮启动。
export const inject = [];

const AGENT = process.env.GLM_AGENT || 'H:\\GLM\\agent\\glm-chat.mjs';
const GLM_HOME = process.env.GLM_HOME || 'H:\\GLM\\home';
const CHAT_DIR = join(GLM_HOME, '.chat');
const SERVER_JSON = join(CHAT_DIR, 'server.json');
const LOG_FILE = join(CHAT_DIR, 'serve.log');
const PREFERRED_PORT = Number(process.env.GLM_PANEL_PORT) || 41234;
const LOCAL_PORT = Number(process.env.GLM_LOCAL_PORT) || 11434;
const BACKEND_FILE = join(CHAT_DIR, 'backend');
const ROUTE = '/glm-panel';

const NODE_CANDIDATES = [
  process.env.GLM_NODE,
  process.execPath,          // 宿主自己的 node（Electron 里可能是 electron.exe，先试再说）
  'node',
  'F:\\Jave\\node.exe',
  'C:\\Program Files\\nodejs\\node.exe',
].filter(Boolean);

let child = null;
let info = null;
let spawnPromise = null;
let disposed = false;
let restarts = 0;
let childMode = null;   // 这个子进程实际用的后端：cloud / local
let wantedMode = null;  // 上一次从配置读到的后端
const tail = [];

function note(line) {
  const stamp = new Date().toISOString().slice(11, 19);
  const text = `[${stamp}] ${line}`;
  tail.push(text);
  if (tail.length > 200) tail.shift();
  try {
    mkdirSync(CHAT_DIR, { recursive: true });
    appendFileSync(LOG_FILE, text + '\n', 'utf8');
  } catch { /* 写不了日志不影响功能 */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readServerInfo() {
  try {
    const j = JSON.parse(readFileSync(SERVER_JSON, 'utf8'));
    if (j && Number(j.port) > 0) return j;
  } catch { /* 没有就是还没起来 */ }
  return null;
}

/** 后端开关：环境变量 GLM_PANEL_BASE > `home\.chat\backend` 文件 > 缺省 cloud。 */
function readBackend() {
  try {
    const env = (process.env.GLM_PANEL_BASE || '').trim().toLowerCase();
    if (env === 'local' || env === 'cloud') return env;
    const raw = readFileSync(BACKEND_FILE, 'utf8').trim().toLowerCase();
    if (raw === 'local' || raw === 'cloud') return raw;
  } catch { /* 文件不存在就缺省 */ }
  return 'cloud';
}

/** 本地 9B 起来没有。 */
async function localUp() {
  const h = await probe(LOCAL_PORT, 900);
  // python 小服务回 {"ok":true,...}；llama.cpp 的 llama-server 回 {"status":"ok"}（加载中为 503）。
  // 两种都算活着，否则换成 llama.cpp 后面板会误判「本地没起来」而退回云端。
  return !!(h && (h.ok === true || h.status === 'ok'));
}

function probe(port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

function resolveNode() {
  for (const candidate of NODE_CANDIDATES) {
    if (candidate === 'node') return candidate; // 交给 PATH
    if (existsSync(candidate)) return candidate;
  }
  return 'node';
}

/** /health 报的后端是本地还是云端。 */
function modeOf(health) {
  return health && health.base === 'local' ? 'local' : 'cloud';
}

/** 现在**实际能用**的后端：配置要 local 但本地服务没起来，就只能先 cloud。 */
async function desiredMode() {
  const wanted = readBackend();
  if (wanted !== 'local') return 'cloud';
  return (await localUp()) ? 'local' : 'cloud';
}

async function ensureUp() {
  const target = await desiredMode();
  if (info) {
    const h = await probe(info.port);
    if (h && h.ok && modeOf(h) === target) return info;
    info = null; // 后端不对（或已经死了）就当没有
  }
  const running = readServerInfo();
  if (running) {
    const h = await probe(running.port);
    if (h && h.ok) {
      if (modeOf(h) === target) {
        info = running; // 现成的服务后端正好对上，直接接上
        return info;
      }
      // 纯本地：配置要 local、现有服务也是 local —— 11434 只是暂时没起来（重启/加载模型几十秒），
      // 不能因为这一下就把它换成 cloud 再换回来：每换一次都掐断在途对话，而且用户明确要求
      //「纯本地、失败不兜云端」。2026-10-21 演练 9B 重启时踩到，面板把 local 服务杀了换 cloud。
      if (modeOf(h) === 'local' && readBackend() === 'local') {
        note('本地 9B 暂时不可达，保留现有 local 服务（纯本地，不兜云端）');
        info = running;
        return info;
      }
      // 只在目标后端**确实可用**时才换人；否则「杀了云端又拉不起本地」会来回抖（踩过）
      if (h.pid) {
        note(`现有服务是 ${modeOf(h)}，目标 ${target}，让它退出（pid=${h.pid}）`);
        try { process.kill(h.pid); } catch { /* 已经死了或没权限 */ }
        await sleep(800);
      }
    }
  }
  return spawnServer(target);
}

/**
 * 后端该换了吗：配置改过、或者本地当初没起来而现在起来了，就把子进程换掉（杀进程让 exit 处理器重拉）。
 * 返回 true = 已经在重拉。
 */
async function maybeSwitchBackend() {
  if (!child) return false;
  const wanted = readBackend();
  if (wanted === childMode) { wantedMode = wanted; return false; }
  // 要本地但 11434 还没起来 → 只记下配置，先不切（下一轮再看）
  if (wanted === 'local' && !(await localUp())) { wantedMode = wanted; return false; }
  wantedMode = wanted;
  note(`后端从 ${childMode} 切到 ${wanted}，重启服务`);
  try { child.kill(); } catch { /* 已经死了 */ }
  return true;
}

function spawnServer(preferredMode) {
  if (spawnPromise) return spawnPromise;
  spawnPromise = (async () => {
    if (!existsSync(AGENT)) throw new Error('找不到她的 agent 脚本：' + AGENT);
    const node = resolveNode();
    // 用调用方算好的模式；没给就自己判断（要本地必须先确认 11434 活着，否则退回云端）
    wantedMode = readBackend();
    let mode = preferredMode || wantedMode;
    if (mode === 'local' && !(await localUp())) {
      if (wantedMode === 'local') {
        // 纯本地模式：11434 正在重启/加载也别偷偷兜云端，等它回来（请求会报错，但不会跑云端）
        note(`本地后端 127.0.0.1:${LOCAL_PORT} 还没起（重启/加载中），按纯本地拉起，不兜云端`);
      } else {
        mode = 'cloud';
        note(`本地后端 127.0.0.1:${LOCAL_PORT} 没响应，这次先用 cloud（配置仍是 local，等它起来会自动切回去）`);
      }
    }
    const args = [AGENT, '--serve', ...(mode === 'local' ? ['--local'] : []), '--port', String(PREFERRED_PORT)];
    note(`拉起服务：${node} ${args.join(' ')}（backend=${mode}）`);
    childMode = mode;
    const c = spawn(node, args, {
      cwd: dirname(AGENT),
      env: { ...process.env, GLM_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child = c;
    c.stdout.setEncoding('utf8');
    c.stderr.setEncoding('utf8');
    c.stdout.on('data', (d) => note('[out] ' + String(d).trim()));
    c.stderr.on('data', (d) => note('[err] ' + String(d).trim()));
    c.on('error', (e) => note('[spawn-error] ' + String(e && e.message || e)));
    c.on('exit', (code, signal) => {
      note(`[exit] code=${code} signal=${signal}`);
      if (child === c) { child = null; childMode = null; }
      info = null;
      if (!disposed && restarts < 5) {
        restarts += 1;
        setTimeout(() => { ensureUp().catch((e) => note('[restart-failed] ' + String(e && e.message || e))); }, 2000);
      }
    });

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const i = readServerInfo();
      if (i && Number(i.pid) === c.pid) {
        const h = await probe(i.port);
        if (h && h.ok) {
          info = i;
          restarts = 0;
          note(`服务就绪：127.0.0.1:${i.port} pid=${i.pid}`);
          return info;
        }
      }
      if (c.exitCode !== null) break;
      await sleep(250);
    }
    throw new Error('GLM 服务没起来（20 秒）。最近的输出：' + tail.slice(-5).join(' | '));
  })().finally(() => { spawnPromise = null; });
  return spawnPromise;
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(raw.trim() ? JSON.parse(raw) : {}); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/**
 * 面板上那个「本地/云端」开关：写 backend 文件 + 立刻把 serve 换成对应后端。
 * 目标不可达时不折腾现有服务（本地没起来还硬切，就会重演之前那个重启风暴）。
 */
async function switchBackend(mode) {
  try {
    mkdirSync(CHAT_DIR, { recursive: true });
    writeFileSync(BACKEND_FILE, mode, 'utf8');
  } catch (e) {
    return { ok: false, error: '写不了 ' + BACKEND_FILE + '：' + String((e && e.message) || e) };
  }
  const up = await localUp();
  if (mode === 'local' && !up) {
    return { ok: true, wanted: 'local', effective: childMode, localUp: false, warning: '本地 9B 没起来（11434 没响应），先继续用云端' };
  }
  wantedMode = mode;
  if (child) {
    note(`面板里把后端切到 ${mode}，重启服务`);
    try { child.kill(); } catch { /* 已经死了 */ }
    // 等服务换成新后端（本地模式要重新 spawn 一个带 --local 的）
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await sleep(250);
      if (child && childMode === mode) {
        const i = readServerInfo();
        if (i && await probe(i.port)) { info = i; break; }
      }
    }
  } else {
    await ensureUp().catch(() => {});
  }
  return { ok: true, wanted: mode, effective: childMode, localUp: up };
}

function attach(ctx, scope) {
  return scope.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      // 面板上的「本地 / 云端」开关（宿主自己的路由，不走她的服务）
      if (url.pathname === ROUTE + '/backend') {
        if (req.method === 'GET') {
          return sendJson(res, 200, { ok: true, wanted: readBackend(), effective: childMode, localUp: await localUp() });
        }
        if (req.method === 'POST') {
          const body = await readJsonBody(req);
          const mode = body.mode === 'local' ? 'local' : body.mode === 'cloud' ? 'cloud' : null;
          if (!mode) return sendJson(res, 400, { ok: false, error: 'mode 只能是 local 或 cloud' });
          return sendJson(res, 200, await switchBackend(mode));
        }
        return sendJson(res, 405, { ok: false, error: '只支持 GET / POST' });
      }
      if (url.pathname === ROUTE + '/diag') {
        const up = info ? await probe(info.port) : null;
        return sendJson(res, 200, {
          ok: true,
          agent: AGENT,
          home: GLM_HOME,
          port: info ? info.port : null,
          pid: info ? info.pid : null,
          reachable: !!up,
          childPid: child ? child.pid : null,
          backend: childMode,
          backendWanted: wantedMode,
          backendFile: BACKEND_FILE,
          localPort: LOCAL_PORT,
          localUp: await localUp(),
          tail: tail.slice(-25),
        });
      }

      // /glm-panel/api/<她的路由> → 127.0.0.1:<port>/<她的路由>
      const rest = url.pathname.startsWith(ROUTE + '/api') ? url.pathname.slice((ROUTE + '/api').length) || '/' : null;
      if (rest === null) return sendJson(res, 404, { ok: false, error: '不认识的路径：' + url.pathname });

      let target;
      try {
        target = await ensureUp();
      } catch (e) {
        return sendJson(res, 503, { ok: false, error: String((e && e.message) || e) });
      }

      const path = rest + (url.search || '');
      const headers = { ...req.headers, host: `127.0.0.1:${target.port}` };
      delete headers.connection;

      const preq = httpRequest({
        host: '127.0.0.1',
        port: target.port,
        path,
        method: req.method,
        headers,
      }, (pres) => {
        const isStream = String(pres.headers['content-type'] || '').includes('text/event-stream');
        const out = {
          'Content-Type': pres.headers['content-type'] || 'application/octet-stream',
          'Cache-Control': 'no-store, no-transform',
        };
        if (isStream) {
          out['X-Accel-Buffering'] = 'no';
          out.Connection = 'keep-alive';
        }
        res.writeHead(pres.statusCode || 502, out);
        if (isStream) {
          // 长回复要走很久，别让宿主的 socket 超时把流掐了
          try { res.socket.setTimeout(0); } catch { /* 没有 socket 就算了 */ }
          res.flushHeaders?.();
        }
        pres.pipe(res);
        pres.on('error', () => { try { res.end(); } catch { /* 已断 */ } });
      });

      preq.on('error', (e) => {
        if (!res.headersSent) sendJson(res, 502, { ok: false, error: '转发失败：' + String((e && e.message) || e) });
        else { try { res.end(); } catch { /* 已断 */ } }
      });

      // 请求体原样转过去（/send 是 POST JSON；GET 没有 body，pipe 完就自动 end）
      req.pipe(preq);
    },
  });
  // 返回路由的 disposer —— apply 里用 scope.effect 包着，卸载时会收掉
}

export function apply(ctx) {
  note('glm-panel 激活');
  try {
    ctx.inject(['webServer'], (scope) => {
      try {
        // 路由必须挂在 effect 里：插件卸载/重载时要收掉，否则重载会撞 "duplicate prefix route"
        scope.effect(() => attach(ctx, scope), 'glm-panel: route');
        // 激活就先把她拉起来，省得第一次点开要等
        ensureUp().catch((e) => note('[startup] ' + String((e && e.message) || e)));
        const tick = setInterval(() => {
          if (disposed) return;
          maybeSwitchBackend()
            .then(() => ensureUp())
            .catch((e) => note('[tick] ' + String((e && e.message) || e)));
        }, 30000);
        scope.effect(() => () => clearInterval(tick), 'glm-panel: health tick');
      } catch (e) {
        note('[route-register-failed] ' + String((e && e.message) || e));
      }
    });
  } catch (e) {
    note('[inject-failed] ' + String((e && e.message) || e));
  }
  ctx.effect(() => () => {
    disposed = true;
    if (child) {
      note('插件卸载，收掉服务 pid=' + child.pid);
      try { child.kill(); } catch { /* 已经死了 */ }
      child = null;
    }
  }, 'glm-panel: child process');
}
