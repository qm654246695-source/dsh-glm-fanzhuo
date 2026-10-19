// group-chat-panel —— 宿主半
//
// 只做一件事：把 /group-chat/* 同源转发到群聊服务（默认 127.0.0.1:41300，H:\GLM\group-chat\server.mjs）。
// 不拉起进程、不碰 provider、不建会话——群聊服务是谁起的就谁看，我这里只当插头。
//
// 防御姿势和 glm-panel 一致：inject 为空、webServer 用 ctx.inject 可选挂、route 注册包在
// scope.effect 里、整段 try/catch。插件加载失败最多是没入口，不会拖垮宿主启动。

import { request as httpRequest } from 'node:http';

export const name = 'group-chat-panel';
export const inject = [];

const ROUTE = '/group-chat';
const PORT = Number(process.env.GROUP_CHAT_PORT) || 41300;
const tail = [];

function note(line) {
  const t = '[' + new Date().toISOString().slice(11, 19) + '] ' + line;
  tail.push(t);
  if (tail.length > 100) tail.shift();
  try { console.log('[group-chat-panel] ' + line); } catch { /* 没有控制台也无所谓 */ }
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

function handler(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const path = url.pathname;

  if (path === ROUTE + '/diag') {
    return sendJson(res, 200, { ok: true, port: PORT, route: ROUTE, tail: tail.slice(-20) });
  }
  if (!path.startsWith(ROUTE + '/')) {
    return sendJson(res, 404, { ok: false, error: '不认识的路径：' + path });
  }

  const rest = path.slice(ROUTE.length) || '/';
  const headers = { ...req.headers, host: `127.0.0.1:${PORT}` };
  delete headers.connection;

  const preq = httpRequest({
    host: '127.0.0.1',
    port: PORT,
    path: rest + (url.search || ''),
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
      try { res.socket.setTimeout(0); } catch { /* 没 socket 就算了 */ }
      res.flushHeaders?.();
    }
    pres.pipe(res);
    pres.on('error', () => { try { res.end(); } catch { /* 已断 */ } });
  });

  preq.on('error', (e) => {
    if (!res.headersSent) {
      sendJson(res, 503, {
        ok: false,
        error: '群聊服务没起（127.0.0.1:' + PORT + '）：' + String((e && e.message) || e) +
               '。跑 H:\\GLM\\group-chat\\start.bat 或告诉我一声。',
      });
    } else { try { res.end(); } catch { /* 已断 */ } }
  });

  req.pipe(preq);
}

export function apply(ctx) {
  note('group-chat-panel 激活');
  try {
    ctx.inject(['webServer'], (scope) => {
      try {
        scope.effect(() => scope.webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler,
        }), 'group-chat-panel: route');
        note('路由已挂：' + ROUTE + '/*  →  127.0.0.1:' + PORT);
      } catch (e) {
        note('[route-register-failed] ' + String((e && e.message) || e));
      }
    });
  } catch (e) {
    note('[inject-failed] ' + String((e && e.message) || e));
  }
}
