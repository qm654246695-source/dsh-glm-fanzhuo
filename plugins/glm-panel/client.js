// glm-panel 的客户端半：左边栏一个「她」的图标，点开是聊天面板。
//
// 这个文件是浏览器里跑的：window.__ModuleLoader__ 的懒加载工厂，React 从模块表里拿。
// 只做三件事：注册侧边栏图标、注册主面板、画界面。
// 数据全走 /glm-panel/api/*（宿主半转发到 H:\GLM 那条本机服务），这里不碰模型、不碰文件。
window.__ModuleLoader__.load({
  id: 'glm-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback } = React;

    const NS = 'glm-panel';
    const PANEL_ID = 'glm';
    const API = '/glm-panel/api';

    /** 文案函数：先在下面按中文兜底，apply 时再换成 locale 绑定的版本。 */
    let t = (key) => key;

    const zh = {
      panel: 'GLM',
      title: 'GLM',
      subtitle: '住在 H: 盘上的那位',
      newSession: '新会话',
      session: '会话',
      model: '模型',
      send: '发',
      stop: '停',
      sending: '她正在想…',
      placeholder: '跟她说点什么…（回车发送，Shift+回车换行）',
      hint: '回车发送 · Shift+回车换行',
      empty: '她还没开口。发一句试试。',
      loading: '连接中…',
      offline: '她不在线：{msg}',
      thinking: '思考了 {n} 字',
      think: '想了想',
      tool: '动手',
      error: '出错',
      stopped: '已按停',
      retry: '重试',
      conn: '连不上她的服务：{msg}',
      noTurns: '还没聊过',
      turns: '{n} 轮',
      backendLocal: '本地',
      backendCloud: '云端',
      backendLocalHint: '本机 9B 在推理：离线、约 19 tok/s，首字 1–3 秒',
      backendCloudHint: '走智谱云端：更快更聪明，按 token 计费',
      switchToLocal: '点一下切到本机 9B（离线、免费）',
      switchToCloud: '点一下切到智谱云端（更快更聪明）',
      switching: '切换中…',
      localDown: '本地 9B 没起来（11434 无响应）',
      conversations: '对话',
      archive: '归档',
      restore: '恢复',
      archived: '已归档',
      pin: '置顶',
      unpin: '取消置顶',
      noConversations: '还没有对话',
      renameHint: '双击改名 · 拖到别处换顺序',
    };

    const en = {
      panel: 'GLM',
      title: 'GLM',
      subtitle: 'the one who lives on drive H:',
      newSession: 'New chat',
      session: 'Chat',
      model: 'Model',
      send: 'Send',
      stop: 'Stop',
      sending: 'She is thinking…',
      placeholder: 'Say something to her… (Enter to send, Shift+Enter for a newline)',
      hint: 'Enter sends · Shift+Enter newline',
      empty: 'She has not said anything yet. Try a message.',
      loading: 'Connecting…',
      offline: 'She is not online: {msg}',
      thinking: 'thought {n} chars',
      think: 'Thinking',
      tool: 'Tool',
      error: 'Error',
      stopped: 'Stopped',
      retry: 'Retry',
      conn: 'Cannot reach her service: {msg}',
      noTurns: 'no messages yet',
      turns: '{n} turns',
      backendLocal: 'local',
      backendCloud: 'cloud',
      backendLocalHint: 'Local 9B on this machine: offline, ~19 tok/s, first token in 1–3 s',
      backendCloudHint: 'Zhipu cloud: smarter and faster, billed per token',
      switchToLocal: 'click to switch to the local 9B (offline, free)',
      switchToCloud: 'click to switch to the Zhipu cloud (smarter)',
      switching: 'switching…',
      localDown: 'local 9B is not running (11434 not responding)',
      conversations: 'Chats',
      archive: 'archive',
      restore: 'restore',
      archived: 'archived',
      pin: 'pin to top',
      unpin: 'unpin',
      noConversations: 'no chats yet',
      renameHint: 'double-click to rename · drag to reorder',
    };

    // locale 还没绑上（或者绑了但查不到词条）时的兜底：直接给中文，
    // 免得界面上漏出 "panel" / "hint" 这种 key —— 左栏那个名字要的就是 GLM。
    t = (key, vars) => params(zh[key] != null ? zh[key] : key, vars);

    const MODEL_PRESETS = [
      { id: 'glm-5.3-flash', label: '5.3-flash', think: true, effort: 'high' },
      { id: 'glm-5.2', label: '5.2 快', think: false, effort: null },
      { id: 'glm-4.6', label: '4.6 快', think: false, effort: null },
      { id: 'glm-4.6v', label: '4.6V 看图', think: true, effort: null },
    ];

    // 面板自己的小样式表：对话行、悬停出现的置顶/归档按钮、拖拽高亮。
    // 用 <style> 元素渲染在树里，组件卸载时一起消失；颜色全走主题 token。
    const PANEL_CSS = [
      '.glm-prow{display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:8px;cursor:pointer;margin-bottom:2px;border:1px solid transparent;user-select:none}',
      '.glm-prow:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.glm-prow[data-active="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}',
      '.glm-prow[data-drop="true"]{outline:1px dashed var(--dsw-alias-brand-primary);outline-offset:-1px}',
      '.glm-ptitle{flex:1;min-width:0;font-size:12.5px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.glm-pmeta{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.glm-pact{flex:none;border:none;background:transparent;cursor:pointer;font-size:11px;line-height:16px;padding:0 2px;color:var(--dsw-alias-label-secondary);opacity:0;transition:opacity .12s}',
      '.glm-prow:hover .glm-pact{opacity:1}',
      '.glm-prow[data-pinned="true"] .glm-pin{opacity:1;color:var(--dsw-alias-brand-primary)}',
      '.glm-badge:hover{filter:brightness(1.15)}',
    ].join('\n');

    function params(text, vars) {
      let out = String(text == null ? '' : text);
      for (const [k, v] of Object.entries(vars || {})) out = out.split('{' + k + '}').join(String(v));
      return out;
    }

    // ── 跟宿主半说话 ──────────────────────────────────────────────
    async function api(path, body) {
      const res = await fetch(API + path, body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' }
        : { cache: 'no-store' });
      let data = null;
      try { data = await res.json(); } catch { /* 不是 JSON 就当空的 */ }
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || ('HTTP ' + res.status));
      }
      return data;
    }

    /** 把 .chat/sessions/*.jsonl 的记录折成界面上的行。 */
    function rowsFromLog(messages) {
      const rows = [];
      for (const rec of messages || []) {
        const m = rec && rec.msg;
        if (!m) continue;
        if (m.role === 'user') {
          rows.push({ k: 'user', text: String(m.content || '') });
        } else if (m.role === 'assistant') {
          for (const call of m.tool_calls || []) {
            rows.push({ k: 'tool', name: call.function && call.function.name, args: String((call.function && call.function.arguments) || '').slice(0, 400) });
          }
          const text = String(m.content || '').trim();
          if (text) rows.push({ k: 'assistant', text });
        } else if (m.role === 'tool') {
          rows.push({ k: 'toolresult', name: rec.tool || '', out: String(m.content || '').slice(0, 400) });
        }
      }
      return rows;
    }

    // ── 一行行小东西 ──────────────────────────────────────────────
    function ToolRow({ row }) {
      const [open, setOpen] = useState(false);
      const brief = row.args || '';
      return h('div', {
        onClick: () => setOpen(!open),
        style: {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 11.5, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)',
          display: 'flex', gap: 6, cursor: brief ? 'pointer' : 'default', alignItems: 'baseline',
        },
      },
        h('span', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '· ' + (row.name || '?')),
        h('span', { style: { opacity: 0.8 } }, open ? brief : brief.slice(0, 90) + (brief.length > 90 ? '…' : ''))
      );
    }

    function ToolResultRow({ row }) {
      const [open, setOpen] = useState(false);
      const out = String(row.out || '').replace(/\n/g, ' ');
      return h('div', {
        onClick: () => setOpen(!open),
        style: {
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 11.5, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)',
          opacity: 0.75, display: 'flex', gap: 6, cursor: 'pointer', alignItems: 'baseline',
        },
      },
        h('span', { style: { color: 'var(--dsw-alias-state-success-primary)' } }, '↳'),
        h('span', {}, open ? out : out.slice(0, 100) + (out.length > 100 ? '…' : ''))
      );
    }

    function ThinkRow({ row }) {
      const [open, setOpen] = useState(false);
      return h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } },
        h('div', { onClick: () => setOpen(!open), style: { cursor: 'pointer', opacity: 0.8 } },
          '✳ ' + params(t('thinking'), { n: (row.text || '').length })),
        open ? h('div', { style: { whiteSpace: 'pre-wrap', marginTop: 6, paddingLeft: 10, borderLeft: '2px solid var(--dsw-alias-border-l1)', opacity: 0.85 } }, row.text) : null
      );
    }

    /** 极简 markdown：代码块、行内代码。够用就行，别引第三方。 */
    function renderRich(text) {
      const parts = String(text || '').split(/```/);
      const nodes = [];
      parts.forEach((part, i) => {
        if (i % 2 === 1) {
          const body = part.replace(/^[a-zA-Z0-9]*\n/, '');
          nodes.push(h('pre', {
            key: 'pre' + i,
            style: {
              background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: 8, padding: '10px 12px', overflowX: 'auto', margin: '8px 0',
              fontSize: 12.5, lineHeight: '19px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            },
          }, body));
          return;
        }
        String(part).split(/(`[^`\n]+`)/).forEach((seg, j) => {
          if (!seg) return;
          if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
            nodes.push(h('code', {
              key: 'c' + i + '-' + j,
              style: { background: 'var(--dsw-alias-bg-layer-2)', borderRadius: 4, padding: '1px 5px', fontSize: '0.92em' },
            }, seg.slice(1, -1)));
          } else {
            nodes.push(h('span', { key: 't' + i + '-' + j, style: { whiteSpace: 'pre-wrap' } }, seg));
          }
        });
      });
      return nodes;
    }

    // ── 主面板 ────────────────────────────────────────────────────
    function Panel() {
      const [sessions, setSessions] = useState([]);
      const [session, setSession] = useState(null);
      const [rows, setRows] = useState([]);
      const [draft, setDraft] = useState('');
      const [busy, setBusy] = useState(false);
      const [status, setStatus] = useState(t('loading'));
      const [fatal, setFatal] = useState(null);
      const [modelId, setModelId] = useState('glm-5.3-flash');
      const [presets, setPresets] = useState(MODEL_PRESETS);
      const [backend, setBackend] = useState(null);
      const [localUp, setLocalUp] = useState(true);
      const [switching, setSwitching] = useState(false);
      const [showArchived, setShowArchived] = useState(false);
      const [editId, setEditId] = useState(null);
      const [editText, setEditText] = useState('');
      const [dropId, setDropId] = useState(null);
      const dragIdRef = useRef(null);
      const listRef = useRef(null);
      const stickRef = useRef(true);
      const abortRef = useRef(null);

      // 后端是云还是本机 9B：/models 给实际在用的，/glm-panel/backend 给「想要哪个 + 本地起没起」
      const refreshMode = useCallback(async () => {
        let base = null;
        try {
          const m = await api('/models');
          if (Array.isArray(m.presets) && m.presets.length) {
            setPresets(m.presets);
            setModelId((cur) => (m.presets.some((p) => p.id === cur) ? cur : m.presets[0].id));
          }
          base = m.base || null;
          setBackend(base);
        } catch { /* 服务还没起来：先用默认预设，别把面板弄瞎 */ }
        try {
          const r = await fetch('/glm-panel/backend', { cache: 'no-store' });
          if (r.ok) {
            const j = await r.json();
            if (j && j.ok !== false) setLocalUp(j.localUp !== false);
          }
        } catch { /* 宿主路由不在就按「本地可用」显示，别吓人 */ }
        return base;
      }, []);

      const scrollToEnd = useCallback(() => {
        const el = listRef.current;
        if (el && stickRef.current) el.scrollTop = el.scrollHeight;
      }, []);

      const refreshSessions = useCallback(async () => {
        const data = await api('/sessions');
        setSessions(data.sessions || []);
        return data;
      }, []);

      const openLog = useCallback(async (sid) => {
        const data = await api('/log' + (sid ? '?session=' + encodeURIComponent(sid) : ''));
        setSession(data.session || null);
        setRows(rowsFromLog(data.messages));
        stickRef.current = true;
        setTimeout(scrollToEnd, 0);
      }, [scrollToEnd]);

      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            setStatus(t('loading'));
            refreshMode();
            const data = await refreshSessions();
            if (!alive) return;
            await openLog(data.current || null);
            if (!alive) return;
            setStatus(null);
          } catch (e) {
            if (!alive) return;
            setFatal(String(e.message || e));
            setStatus(null);
          }
        })();
        return () => { alive = false; };
      }, [refreshSessions, openLog, refreshMode]);

      useEffect(() => { scrollToEnd(); }, [rows, scrollToEnd]);

      const push = useCallback((row) => {
        stickRef.current = true;
        setRows((prev) => prev.concat([row]));
      }, []);

      // 点一下在本地 / 云端之间切：写 backend 文件 + 让宿主把 serve 换掉。
      // 注意：它依赖 push / refreshSessions，必须定义在它们之后（放前面会在渲染时踩 TDZ 把面板打空）。
      const toggleBackend = useCallback(async () => {
        if (switching) return;
        const next = backend === 'local' ? 'cloud' : 'local';
        setSwitching(true);
        try {
          const r = await fetch('/glm-panel/backend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: next }),
          });
          const j = await r.json().catch(() => null);
          if (!r.ok || !j || j.ok === false) throw new Error((j && j.error) || ('HTTP ' + r.status));
          if (j.warning) push({ k: 'note', text: j.warning });
          // serve 会重启一次，等它回来再刷新模型档位
          for (let i = 0; i < 40; i++) {
            await new Promise((res) => setTimeout(res, 500));
            const base = await refreshMode();
            if (base) break;
          }
          await refreshSessions().catch(() => {});
        } catch (e) {
          push({ k: 'error', text: String(e.message || e) });
        } finally {
          setSwitching(false);
        }
      }, [backend, switching, push, refreshMode, refreshSessions]);

      const delta = useCallback((kind, text) => {
        setRows((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.k === kind && last.open) {
            return prev.slice(0, -1).concat([{ ...last, text: (last.text || '') + text }]);
          }
          const out = last && last.open ? prev.slice(0, -1).concat([{ ...last, open: false }]) : prev.slice();
          out.push({ k: kind, text, open: true });
          return out;
        });
      }, []);

      const closeOpen = useCallback(() => {
        setRows((prev) => {
          const last = prev[prev.length - 1];
          return last && last.open ? prev.slice(0, -1).concat([{ ...last, open: false }]) : prev;
        });
      }, []);

      const handleFrame = useCallback((frame) => {
        let ev = 'message';
        let dataLine = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) ev = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
        }
        let payload = {};
        try { payload = dataLine ? JSON.parse(dataLine) : {}; } catch { payload = {}; }
        if (ev === 'session') {
          if (payload.session) setSession(payload.session);
        } else if (ev === 'think') {
          delta('think', payload.text || '');
        } else if (ev === 'text') {
          delta('assistant', payload.text || '');
        } else if (ev === 'tool') {
          closeOpen();
          push({ k: 'tool', name: payload.name, args: String(payload.args || '') });
        } else if (ev === 'toolresult') {
          push({ k: 'toolresult', name: payload.name, out: String(payload.out || '') });
        } else if (ev === 'error') {
          push({ k: 'error', text: String(payload.message || '?') });
        } else if (ev === 'aborted') {
          push({ k: 'note', text: t('stopped') });
        } else if (ev === 'done') {
          closeOpen();
          setBusy(false);
        }
      }, [delta, push, closeOpen]);

      const send = useCallback(async () => {
        const text = draft.trim();
        if (!text || busy) return;
        const preset = presets.find((m) => m.id === modelId) || presets[0];
        setDraft('');
        setBusy(true);
        setFatal(null);
        push({ k: 'user', text });
        const ac = new AbortController();
        abortRef.current = ac;
        try {
          const res = await fetch(API + '/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              text,
              session,
              model: preset.id,
              think: preset.think,
              effort: preset.effort || undefined,
            }),
            signal: ac.signal,
          });
          if (!res.ok || !res.body) {
            let msg = 'HTTP ' + res.status;
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch { /* 保持原样 */ }
            throw new Error(msg);
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx);
              buf = buf.slice(idx + 2);
              handleFrame(frame);
            }
          }
          if (buf.trim()) handleFrame(buf);
        } catch (e) {
          if (e && e.name === 'AbortError') {
            push({ k: 'note', text: t('stopped') });
            try { await api('/abort', { session }); } catch { /* 服务那边可能已经停了 */ }
          } else {
            push({ k: 'error', text: String(e.message || e) });
          }
        } finally {
          abortRef.current = null;
          setBusy(false);
          refreshSessions().catch(() => {});
          refreshMode().catch(() => {});
        }
      }, [draft, busy, modelId, presets, session, push, closeOpen, handleFrame, refreshSessions, refreshMode]);

      const stop = useCallback(() => {
        if (abortRef.current) abortRef.current.abort();
      }, []);

      const newSession = useCallback(async () => {
        try {
          const data = await api('/new', {});
          setSession(data.session);
          setRows([]);
          await refreshSessions();
        } catch (e) {
          setFatal(String(e.message || e));
        }
      }, [refreshSessions]);

      const switchSession = useCallback(async (sid) => {
        if (!sid) return;
        try {
          await api('/select', { session: sid });
          await openLog(sid);
          await refreshSessions();
        } catch (e) {
          setFatal(String(e.message || e));
        }
      }, [openLog, refreshSessions]);

      // 改名：双击行 → 输入框 → 回车/失焦提交
      const rename = useCallback(async (sid, title) => {
        setEditId(null);
        const next = String(title || '').trim().slice(0, 80);
        if (!next) return;
        try {
          await api('/rename', { session: sid, title: next });
          await refreshSessions();
        } catch (e) {
          setFatal(String(e.message || e));
        }
      }, [refreshSessions]);

      // 归档 / 恢复：只动小本子，聊天记录一个字不删
      const toggleArchive = useCallback(async (sid, archived) => {
        try {
          await api('/archive', { session: sid, archived });
          await refreshSessions();
        } catch (e) {
          setFatal(String(e.message || e));
        }
      }, [refreshSessions]);

      // 置顶 / 取消置顶：置顶的永远排在最前，面板重排照旧
      const togglePin = useCallback(async (sid, pinned) => {
        try {
          await api('/pin', { session: sid, pinned });
          await refreshSessions();
        } catch (e) {
          setFatal(String(e.message || e));
        }
      }, [refreshSessions]);

      // 拖动排序：先本地重排（手感即时），再把整条 id 列表交给服务落盘
      const reorder = useCallback((fromId, toId) => {
        const actives = sessions.filter((s) => !s.archived).map((s) => s.id);
        const from = actives.indexOf(fromId);
        const to = actives.indexOf(toId);
        if (from < 0 || to < 0 || from === to) return;
        const next = actives.slice();
        next.splice(to, 0, next.splice(from, 1)[0]);
        setSessions((prev) => {
          const byId = new Map(prev.map((s) => [s.id, s]));
          const ordered = next.map((id, i) => ({ ...byId.get(id), order: i }));
          return ordered.concat(prev.filter((s) => s.archived));
        });
        api('/order', { ids: next })
          .then(() => refreshSessions())
          .catch((e) => setFatal(String(e.message || e)));
      }, [sessions, refreshSessions]);

      const onKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          send();
        }
      };

      // ── 样式（全部走宿主的主题 token）──────────────────────────
      const S = {
        root: {
          height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column',
          paddingTop: 'var(--dsh-frame-top-clearance, 0px)',
          color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-base)', minHeight: 0,
        },
        head: {
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          padding: '12px clamp(16px, 3vw, 32px)', borderBottom: '1px solid var(--dsw-alias-border-l1)',
        },
        brand: { display: 'flex', flexDirection: 'column', lineHeight: 1.2, marginRight: 4 },
        brandTitle: { fontSize: 15, fontWeight: 600 },
        brandSub: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
        badge: (local) => ({
          alignSelf: 'center', fontSize: 10.5, lineHeight: '18px', padding: '0 7px', borderRadius: 999,
          whiteSpace: 'nowrap',
          color: local ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
          border: '1px solid ' + (local ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-border-l1)'),
          background: 'var(--dsw-alias-bg-layer-1)',
        }),
        spacer: { flex: 1 },
        select: {
          height: 28, maxWidth: 190, borderRadius: 8, padding: '0 8px', fontSize: 12,
          background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
          border: '1px solid var(--dsw-alias-border-l2)',
        },
        ghost: {
          height: 28, padding: '0 10px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
          background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
          border: '1px solid var(--dsw-alias-border-l2)',
        },
        list: { flex: 1, overflowY: 'auto', minHeight: 0, padding: '18px clamp(16px, 3vw, 32px) 8px' },
        body: { flex: 1, display: 'flex', minHeight: 0, minWidth: 0 },
        side: {
          flex: '0 0 232px', width: 232, display: 'flex', flexDirection: 'column', minHeight: 0,
          borderRight: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)',
        },
        sideHead: {
          display: 'flex', alignItems: 'center', gap: 6, padding: '10px 10px 6px',
          fontSize: 11, letterSpacing: '.04em', color: 'var(--dsw-alias-label-secondary)',
        },
        sideTitle: { flex: 1 },
        sideScroll: { flex: 1, overflowY: 'auto', minHeight: 0, padding: '0 6px 8px' },
        sideFoot: {
          borderTop: '1px solid var(--dsw-alias-border-l1)', padding: '7px 10px',
          fontSize: 11, color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer',
        },
        sideHint: { padding: '0 10px 10px', fontSize: 10.5, lineHeight: '15px', color: 'var(--dsw-alias-label-secondary)', opacity: 0.75 },
        chatCol: { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 },
        iconBtn: {
          flex: 'none', border: 'none', background: 'transparent', cursor: 'pointer',
          color: 'var(--dsw-alias-label-secondary)', fontSize: 10.5, lineHeight: '16px', padding: '0 2px',
        },
        convInput: {
          flex: 1, minWidth: 0, height: 22, borderRadius: 6, padding: '0 6px', fontSize: 12.5,
          background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
          border: '1px solid var(--dsw-alias-brand-primary)', outline: 'none', fontFamily: 'inherit',
        },
        inner: { maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 10 },
        user: {
          alignSelf: 'flex-end', maxWidth: '82%', background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, padding: '8px 12px',
          fontSize: 14, lineHeight: '22px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        },
        assistant: { fontSize: 14, lineHeight: '23px', wordBreak: 'break-word' },
        errorRow: {
          fontSize: 12.5, lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary)',
          border: '1px solid var(--dsw-alias-state-error-primary)', borderRadius: 8, padding: '6px 10px',
          whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        },
        noteRow: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
        empty: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13, textAlign: 'center', marginTop: 40 },
        composer: { borderTop: '1px solid var(--dsw-alias-border-l1)', padding: '12px clamp(16px, 3vw, 32px) 14px' },
        composerInner: { maxWidth: 820, margin: '0 auto', display: 'flex', gap: 10, alignItems: 'flex-end' },
        textarea: {
          flex: 1, resize: 'none', minHeight: 44, maxHeight: 200, boxSizing: 'border-box',
          background: 'var(--dsw-alias-bg-layer-1)', border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 10, padding: '11px 12px', color: 'var(--dsw-alias-label-primary)',
          fontSize: 14, lineHeight: '20px', fontFamily: 'inherit', outline: 'none',
        },
        send: {
          height: 40, minWidth: 64, padding: '0 16px', borderRadius: 10, border: 'none', cursor: 'pointer',
          fontSize: 13, fontWeight: 500, color: '#fff', background: 'var(--dsw-alias-brand-primary)',
        },
        stop: {
          height: 40, minWidth: 64, padding: '0 16px', borderRadius: 10, border: 'none', cursor: 'pointer',
          fontSize: 13, fontWeight: 500, color: '#fff', background: 'var(--dsw-alias-state-error-primary)',
        },
        hint: { maxWidth: 820, margin: '6px auto 0', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', display: 'flex', gap: 8 },
      };

      const renderRow = (row, i) => {
        if (row.k === 'user') return h('div', { key: i, style: S.user }, row.text);
        if (row.k === 'assistant') return h('div', { key: i, style: S.assistant }, renderRich(row.text));
        if (row.k === 'think') return h(ThinkRow, { key: i, row });
        if (row.k === 'tool') return h(ToolRow, { key: i, row });
        if (row.k === 'toolresult') return h(ToolResultRow, { key: i, row });
        if (row.k === 'error') return h('div', { key: i, style: S.errorRow }, t('error') + ': ' + row.text);
        if (row.k === 'note') return h('div', { key: i, style: S.noteRow }, row.text);
        return null;
      };

      const activeList = sessions.filter((s) => !s.archived);
      const archivedList = sessions.filter((s) => s.archived);

      // 一条对话：点开 / 双击改名 / 拖到别处换顺序 / 悬停出现置顶、归档按钮
      const convRow = (s) => {
        const active = s.id === session;
        const editing = editId === s.id;
        return h('div', {
          key: s.id,
          className: 'glm-prow',
          'data-active': active ? 'true' : 'false',
          'data-drop': dropId === s.id ? 'true' : 'false',
          'data-pinned': s.pinned ? 'true' : 'false',
          draggable: !editing,
          title: t('renameHint'),
          onDragStart: (e) => {
            dragIdRef.current = s.id;
            try { e.dataTransfer.setData('text/plain', s.id); e.dataTransfer.effectAllowed = 'move'; } catch { /* 老浏览器 */ }
          },
          onDragOver: (e) => { e.preventDefault(); if (dropId !== s.id) setDropId(s.id); },
          onDragLeave: () => { if (dropId === s.id) setDropId(null); },
          onDrop: (e) => {
            e.preventDefault();
            const from = dragIdRef.current;
            dragIdRef.current = null;
            setDropId(null);
            if (from && from !== s.id) reorder(from, s.id);
          },
          onClick: () => { if (!editing && s.id !== session) switchSession(s.id); },
          onDoubleClick: (e) => { e.stopPropagation(); setEditId(s.id); setEditText(s.title || s.id); },
        },
          editing
            ? h('input', {
                style: S.convInput,
                value: editText,
                autoFocus: true,
                onChange: (e) => setEditText(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === 'Enter') { e.preventDefault(); rename(s.id, editText); }
                  else if (e.key === 'Escape') { e.preventDefault(); setEditId(null); }
                },
                onBlur: () => rename(s.id, editText),
              })
            : h('span', { className: 'glm-ptitle', title: s.title || s.id }, s.title || s.id),
          editing ? null : h('span', { className: 'glm-pmeta' }, String(s.turns || 0)),
          editing ? null : h('button', {
            type: 'button',
            className: 'glm-pact glm-pin',
            title: s.pinned ? t('unpin') : t('pin'),
            onClick: (e) => { e.stopPropagation(); togglePin(s.id, !s.pinned); },
          }, s.pinned ? '⇧' : '⇡'),
          editing ? null : h('button', {
            type: 'button',
            className: 'glm-pact',
            title: s.archived ? t('restore') : t('archive'),
            onClick: (e) => { e.stopPropagation(); toggleArchive(s.id, !s.archived); },
          }, s.archived ? '↺' : '⊟')
        );
      };

      const sideColumn = h('div', { style: S.side },
        h('div', { style: S.sideHead },
          h('span', { style: S.sideTitle }, t('conversations')),
          h('span', {}, String(activeList.length))
        ),
        h('div', { style: S.sideScroll },
          activeList.length === 0
            ? h('div', { style: { ...S.noteRow, padding: '4px 8px' } }, t('noConversations'))
            : null,
          activeList.map(convRow),
          archivedList.length
            ? h('div', { style: { marginTop: 6 } },
                h('div', {
                  style: { ...S.sideFoot, borderTop: 'none', padding: '4px 8px' },
                  onClick: () => setShowArchived(!showArchived),
                }, (showArchived ? '▾ ' : '▸ ') + t('archived') + ' (' + archivedList.length + ')'),
                showArchived ? archivedList.map(convRow) : null
              )
            : null
        ),
        h('div', { style: S.sideHint }, t('renameHint'))
      );

      return h('div', { style: S.root },
        h('style', { key: 'glm-panel-css' }, PANEL_CSS),
        h('div', { style: S.head },
          h('div', { style: S.brand },
            h('span', { style: S.brandTitle }, t('title')),
            h('span', { style: S.brandSub }, fatal ? params(t('offline'), { msg: fatal }) : t('subtitle'))
          ),
          backend ? h('button', {
            type: 'button',
            className: 'glm-badge',
            style: {
              ...S.badge(backend === 'local'),
              cursor: switching ? 'progress' : 'pointer',
              fontFamily: 'inherit',
              opacity: switching ? 0.65 : 1,
            },
            disabled: switching,
            title: switching
              ? t('switching')
              : (backend === 'local' ? t('switchToCloud') : (localUp ? t('switchToLocal') : t('localDown'))),
            onClick: toggleBackend,
          }, switching ? t('switching') : (backend === 'local' ? t('backendLocal') : t('backendCloud'))) : null,
          h('div', { style: S.spacer }),
          h('select', {
            style: S.select,
            value: modelId,
            title: t('model'),
            onChange: (e) => setModelId(e.target.value),
          }, presets.map((m) => h('option', { key: m.id, value: m.id }, m.label))),
          h('button', { type: 'button', style: S.ghost, onClick: newSession }, t('newSession'))
        ),

        h('div', { style: S.body },
          sideColumn,
          h('div', { style: S.chatCol },
            h('div', {
              ref: listRef,
              style: S.list,
              onScroll: (e) => {
                const el = e.currentTarget;
                stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
              },
            },
              rows.length === 0
                ? h('div', { style: S.empty }, fatal ? params(t('conn'), { msg: fatal }) : (status || t('empty')))
                : h('div', { style: S.inner },
                    rows.map(renderRow),
                    busy ? h('div', { style: { ...S.noteRow, opacity: 0.75 } }, t('sending')) : null
                  )
            ),

            h('div', { style: S.composer },
              h('div', { style: S.composerInner },
                h('textarea', {
                  style: S.textarea,
                  value: draft,
                  rows: 1,
                  placeholder: t('placeholder'),
                  onChange: (e) => setDraft(e.target.value),
                  onKeyDown,
                }),
                busy
                  ? h('button', { type: 'button', style: S.stop, onClick: stop }, t('stop'))
                  : h('button', { type: 'button', style: S.send, onClick: send, disabled: !draft.trim() }, t('send'))
              ),
              h('div', { style: S.hint }, h('span', {}, t('hint')))
            )
          )
        )
      );
    }

    // ── 侧边栏那个图标 ────────────────────────────────────────────
    // 一颗火花（用户要的「火花」）：中间一颗四角星，右下角一小颗陪着。
    // 用 currentColor 实心填充，跟随主题色和选中态；24×24 视框，边到边。
    function sparkPath(cx, cy, r) {
      const n = (v) => Number(v.toFixed(2));
      return 'M' + n(cx) + ' ' + n(cy - r)
        + 'Q' + n(cx) + ' ' + n(cy) + ' ' + n(cx + r) + ' ' + n(cy)
        + 'Q' + n(cx) + ' ' + n(cy) + ' ' + n(cx) + ' ' + n(cy + r)
        + 'Q' + n(cx) + ' ' + n(cy) + ' ' + n(cx - r) + ' ' + n(cy)
        + 'Q' + n(cx) + ' ' + n(cy) + ' ' + n(cx) + ' ' + n(cy - r) + 'Z';
    }

    function PanelIcon({ size }) {
      const s = size || 18;
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        'aria-hidden': true, style: { display: 'block' },
      },
        h('path', { d: sparkPath(10.3, 10.3, 8.9), fill: 'currentColor' }),
        h('path', { d: sparkPath(19.1, 19.1, 3.5), fill: 'currentColor', opacity: 0.85 })
      );
    }

    // ── 饭桌（群聊）────────────────────────────────────────────────
    // 群聊页面由 group-chat-panel 插件的宿主半转发在 /group-chat/，这里只加一个入口，
    // 直接 iframe 嵌进来——省得再为客户端模块加载折腾一次。
    // 图标按用户要求：明显的「饭桌」——椭圆桌面 + 两条桌腿 + 桌上一碗冒热气的白饭 + 一双筷子。
    function TableIcon({ size }) {
      const s = size || 18;
      return h('svg', {
        width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, style: { display: 'block' },
      },
        // 桌面（俯视的椭圆）
        h('ellipse', { cx: 12, cy: 10.4, rx: 8.6, ry: 3.2 }),
        // 两条桌腿
        h('path', { d: 'M7.4 13v5M16.6 13v5' }),
        // 桌上一碗白饭：实心饭堆 + 碗沿
        h('path', { d: 'M9.7 9.4h4.6a2.3 2.3 0 0 1-4.6 0Z', fill: 'currentColor', stroke: 'none' }),
        // 热气
        h('path', { d: 'M11 7.3c.6-.8-.6-1.4 0-2.3M13.2 7.3c.6-.8-.6-1.4 0-2.3' }),
        // 一双筷子斜插在碗边
        h('path', { d: 'M15.2 9.1 18 4.6M16.3 9.5 19.1 5' })
      );
    }

    function TablePanel() {
      return h('iframe', {
        src: '/group-chat/',
        title: '饭桌',
        style: { width: '100%', height: '100%', border: '0', display: 'block', background: '#0e1116', colorScheme: 'dark' },
      });
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return;
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          try {
            ctx.locale.register(NS, { zh, en });
          } catch { /* HMR 重新 apply 时同一个 ns/locale 会重复注册 → 抛错，但词条已经在，不用管 */ }
          const bound = ctx.locale.bind(NS);
          if (typeof bound === 'function') {
            t = (key, vars) => {
              const s = bound(key, vars);
              // 查不到词条时 translate 会把 key 原样吐回来；这时退回中文，别让 key 见人
              return s === key && zh[key] != null ? params(zh[key], vars) : s;
            };
          }
        }
      } catch { /* locale 整个不可用：保留上面按中文兜底的 t */ }

      // 侧边栏那一排全局面板图标：同一个 id 指向 main 槽里的那块面板。
      // 名字就写 GLM（用户要求：别写 panel），不走 locale。
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 5,
          label: 'GLM',
          locale: NS,
        }, PanelIcon));
      } catch { /* 图标槽不可用就没有入口，面板本身还在 */ }

      // 主面板
      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          locale: NS,
        }, Panel));
      } catch { /* 同上 */ }

      // 饭桌（群聊）：宿主半是 group-chat-panel 插件，转发在 /group-chat/；这里只挂入口
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'group-chat',
          order: 6,
          label: '饭桌',
          locale: NS,
        }, TableIcon));
      } catch { /* 图标槽不可用就没有入口 */ }
      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'group-chat',
          locale: NS,
        }, TablePanel));
      } catch { /* 同上 */ }
    }

    return { name: 'glm-panel', inject: ['slots', 'locale'], apply };
  },
});
