// glm — 一个极小的 GLM 调用器（给我自己当工用小工具用）
// 用法：
//   node glm.mjs "问题"                      纯文本对话（默认 glm-5.3-flash，带思考）
//   node glm.mjs --image a.png "描述这张图"   看图（自动切 glm-4v）
//   node glm.mjs --model glm-4.6 --no-think "问题"        关思考（快，4.6/5-turbo 支持）
//   node glm.mjs --effort low "问题"                      降思考强度（low|high|max；5.3 系列只认这三个）
//   node glm.mjs --max 2000 "问题"
// key 来源：环境变量 GLM_API_KEY，或同目录 .key 文件（首行）
//
// 思考型模型的老毛病：token 全烧在 reasoning 上，content 返回空串。
// 这里内置自动重试：空正文 → 加长 max_tokens → 再降 reasoning_effort；仍空才报 [empty]。

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLOUD = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
// 本地后端：Ollama 的 OpenAI 兼容端点（她的 H: 盘上那份 9B）
const LOCAL = process.env.GLM_LOCAL_BASE || 'http://127.0.0.1:11434/v1/chat/completions';
let BASE = process.env.GLM_BASE || CLOUD;
let isLocal = /127\.0\.0\.1|localhost/.test(BASE);

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const VERBOSE = !!process.env.GLM_VERBOSE;
const log = (s) => { if (VERBOSE) process.stderr.write(s + '\n'); };

function readKey() {
  if (process.env.GLM_API_KEY) return process.env.GLM_API_KEY.trim();
  for (const p of [join(HERE, '.key'), join(process.env.USERPROFILE || '', '.glm.key')]) {
    if (p && existsSync(p)) return readFileSync(p, 'utf8').trim().split(/\r?\n/)[0].trim();
  }
  if (isLocal) return 'local';   // Ollama 不校验 key
  throw new Error('no GLM key: set GLM_API_KEY or create .key next to glm.mjs');
}

// 按魔数认图，别指望文件名（DSH 的附件是没有扩展名的）
function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length > 6 && buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return null;
}

async function post(body) {
  const t0 = Date.now();
  const r = await fetch(BASE, {
    method: 'POST',
    headers: { Authorization: `Bearer ${readKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  const ms = Date.now() - t0;
  if (!r.ok) {
    const e = new Error(`HTTP ${r.status}: ${raw}`);
    e.status = r.status;
    e.raw = raw;
    throw e;
  }
  const j = JSON.parse(raw);
  return { j, ms };
}

async function main() {
  const argv = process.argv.slice(2);
  let model = null, max = 1024, images = [], prompt = [];
  let think = null;          // null=默认（模型自己定）, false=关思考, true=强制开
  let effort = null;         // low | high | max（只对始终思考的模型有效）
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') model = argv[++i];
    else if (a === '--max') max = Number(argv[++i]);
    else if (a === '--image') images.push(argv[++i]);
    else if (a === '--no-think') think = false;
    else if (a === '--think') think = true;
    else if (a === '--effort') effort = argv[++i];
    else if (a === '--local') { BASE = LOCAL; isLocal = true; }
    else if (a === '--base') { BASE = argv[++i]; isLocal = /127\.0\.0\.1|localhost/.test(BASE); }
    else prompt.push(a);
  }
  const text = prompt.join(' ').trim();
  if (!text && images.length === 0) { console.error('need a prompt'); process.exit(2); }
  if (!model) model = isLocal ? 'glm-local' : images.length ? 'glm-4v' : 'glm-5.3-flash';

  const content = [];
  for (const img of images) {
    const abs = resolve(img);
    const buf = readFileSync(abs);
    const base = abs.split(/[\\/]/).pop();
    const ext = (/\.[a-z0-9]{2,5}$/i.exec(base) || [''])[0].toLowerCase();
    const mime = sniff(buf) || MIME[ext];
    if (!mime) throw new Error('unsupported image type: ' + (ext || 'unknown') + ' — ' + abs);
    content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } });
  }
  content.push({ type: 'text', text });
  const userContent = images.length ? content : text;

  // 三轮重试策略：原样 → 加长 → 拉到 8192 + 降思考
  // （实测：始终思考的 5.3 系列给多少 token 就思考多少，所以最后一轮既要加长也要降 effort）
  // 本地 Ollama 后端不认 thinking / reasoning_effort，统一不发这两个参数。
  const attempts = isLocal
    ? [{ max }, { max: Math.min(Math.max(max * 2, 2048), 8192) }, { max: 8192 }]
    : [
        { max, effort, think },
        { max: Math.min(Math.max(max * 2, 2048), 8192), effort, think },
        { max: 8192, effort: effort || 'low', think: think === false ? false : null },
      ];

  let lastEmpty = null;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const body = { model, messages: [{ role: 'user', content: userContent }], max_tokens: a.max };
    if (a.think === false) body.thinking = { type: 'disabled' };
    else if (a.think === true) body.thinking = { type: 'enabled' };
    if (a.effort) body.reasoning_effort = a.effort;

    let res;
    try {
      res = await post(body);
    } catch (e) {
      // 1210 = 参数非法：模型不支持关思考 / effort 取值不对 → 去掉该参数再试一次
      const m = /"code":"(\d+)"/.exec(e.raw || '');
      if (e.status === 400 && m && m[1] === '1210' && (body.thinking || body.reasoning_effort)) {
        log(`  · 第 ${i + 1} 轮参数被拒，去掉思考参数重试`);
        delete body.thinking;
        delete body.reasoning_effort;
        res = await post(body);
      } else throw e;
    }

    const j = res.j;
    const msg = j.choices?.[0]?.message ?? {};
    const out = (msg.content || '').trim();
    const rea = j.usage?.completion_tokens_details?.reasoning_tokens;
    log(`  · 第 ${i + 1} 轮 ${res.ms}ms content=${out.length}字 reasoning=${rea ?? '?'}/${j.usage?.completion_tokens} finish=${j.choices?.[0]?.finish_reason}`);
    if (process.env.GLM_SHOW_USAGE) console.error('usage: ' + JSON.stringify(j.usage));

    if (out) { console.log(out); return; }
    lastEmpty = j;
    log('  · 空正文，重试');
  }

  console.log('[empty]');
  console.error('三次都只出了思考没有正文。finish_reason=' + (lastEmpty?.choices?.[0]?.finish_reason ?? '?') + '，把 --max 或 --effort low 再给大些试试。');
  process.exitCode = 3;
}

main().catch((e) => { console.error('error: ' + e.message); process.exit(1); });
