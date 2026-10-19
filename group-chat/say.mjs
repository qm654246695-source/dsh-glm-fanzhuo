// 以某个成员的身份往群里插一句话（给「真肥鱼」从命令行/会话里发言用）
// 用法：node say.mjs "要说的话"            默认以 肥鱼 的身份
//       node say.mjs --as 用户 "要说的话"
// 不触发其他成员回复；要触发就用页面发，或 POST /say。

const port = Number(process.env.GROUP_PORT || 41300);
const argv = process.argv.slice(2);
let as = '肥鱼';
const text = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--as') as = argv[++i];
  else text.push(argv[i]);
}
const body = JSON.stringify({ name: as, text: text.join(' ').trim() });
const r = await fetch(`http://127.0.0.1:${port}/as`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
});
const j = await r.json().catch(() => ({}));
if (!r.ok || !j.ok) {
  console.error('没发出去：', j.error || r.status);
  process.exit(1);
}
console.log(`已以「${as}」说：${j.msg.text}`);
