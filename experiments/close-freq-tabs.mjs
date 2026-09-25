// close-freq-tabs.mjs — 关闭脚本残留的频控页/空白页，保留用户自己的页面
const base = 'http://127.0.0.1:9335';
const KEEP = [/cart\.jd\.com/, /taobao\.com/, /tmall\.com/, /yangkeduo/, /douyin/];

const ver = await (await fetch(`${base}/json/version`)).json();
const sock = new WebSocket(ver.webSocketDebuggerUrl);
const pend = new Map();
let seq = 0;
sock.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); p(m); }
});
await new Promise((r) => sock.addEventListener('open', r, { once: true }));
const send = (method, params = {}) =>
  new Promise((res) => { const id = ++seq; pend.set(id, res); sock.send(JSON.stringify({ id, method, params })); });

const list = await (await fetch(`${base}/json/list`)).json();
for (const t of list.filter((x) => x.type === 'page')) {
  const url = t.url || '';
  const keep = KEEP.some((re) => re.test(url));
  if (keep) { console.log(`保留  ${t.title.slice(0, 30)}  ${url.slice(0, 60)}`); continue; }
  if (url === 'about:blank' || /pc-frequent-pro|pf\.jd\.com|passport\.jd\.com|京东验证|verify/.test(url + t.title)) {
    await send('Target.closeTarget', { targetId: t.id });
    console.log(`关闭  ${t.title.slice(0, 30)}  ${url.slice(0, 70)}`);
  } else {
    console.log(`跳过  ${t.title.slice(0, 30)}  ${url.slice(0, 60)}`);
  }
}
sock.close();
process.exit(0);
