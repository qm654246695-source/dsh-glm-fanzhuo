// group-chat-panel —— 客户端半
//
// 浏览器里跑：DSH 左侧栏加一个「饭桌」图标，点开是一块 iframe 面板，
// 里面就是 H:\GLM\group-chat 那个群聊页面（经宿主半 /group-chat/* 同源转发）。
// 只注册两个槽：sidebar.panellist（图标）和 main（面板）。不碰模型、不碰文件。

window.__ModuleLoader__.load({
  id: 'group-chat-panel',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'group-chat';
    const SRC = '/group-chat/';

    function PanelIcon({ size }) {
      // 饭桌：椭圆桌面 + 两条桌腿 + 一碗冒热气的白饭 + 一双筷子（和 glm-panel 里那个入口保持同一套）
      const s = size || 18;
      return h(
        'svg',
        {
          width: s, height: s, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.7,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        },
        h('ellipse', { cx: 12, cy: 10.4, rx: 8.6, ry: 3.2 }),
        h('path', { d: 'M7.4 13v5M16.6 13v5' }),
        h('path', { d: 'M9.7 9.4h4.6a2.3 2.3 0 0 1-4.6 0Z', fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M11 7.3c.6-.8-.6-1.4 0-2.3M13.2 7.3c.6-.8-.6-1.4 0-2.3' }),
        h('path', { d: 'M15.2 9.1 18 4.6M16.3 9.5 19.1 5' }),
      );
    }

    function Panel() {
      return h('iframe', {
        src: SRC,
        title: '饭桌群聊',
        style: {
          width: '100%',
          height: '100%',
          border: '0',
          display: 'block',
          background: '#0e1116',
          colorScheme: 'dark',
        },
      });
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return;
      try {
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 6,
          label: '饭桌',
        }, PanelIcon));
      } catch { /* 图标槽不可用就没有入口，面板本身还在 */ }
      try {
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, Panel));
      } catch { /* 同上 */ }
    }

    return { name: 'group-chat-panel', inject: ['slots'], apply };
  },
});
