// shop-login-probe.mjs — 硬验证登录态：访问「需登录页面」，看是否被重定向到登录页
// 判据不依赖 cookie 名，只看落地 URL。用法: node shop-login-probe.mjs [port]
const PORT = Number(process.argv[2] || 9335);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBES = [
  { name: '京东', url: 'https://order.jd.com/center/list.action', hints: ['passport.jd.com', 'login.jd.com'] },
  { name: '淘宝', url: 'https://i.taobao.com/my_taobao.htm', hints: ['login.taobao.com', 'login.tmall.com'] },
  { name: '拼多多', url: 'https://mobile.yangkeduo.com/orders.html', hints: ['login.html'] },
  { name: '闲鱼', url: 'https://www.goofish.com/personal', hints: ['login'] },
];

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const base = `http://127.0.0.1:${PORT}`;
const sock = new WebSocket(ver.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;
sock.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
});
await new Promise((r) => sock.addEventListener('open', r, { once: true }));
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    sock.send(JSON.stringify({ id, method, params }));
  });

console.log(`浏览器: ${ver.Browser}\n`);
for (const p of PROBES) {
  let href = '';
  try {
    const { targetId } = await send('Target.createTarget', { url: p.url });
    await sleep(8000);
    const list = await (await fetch(`${base}/json/list`)).json();
    const t = list.find((x) => x.id === targetId);
    href = t?.url || '(target gone)';
    await send('Target.closeTarget', { targetId });
  } catch (e) {
    href = 'ERR ' + e.message;
  }
  const hit = p.hints.some((h) => href.includes(h));
  console.log(`${hit ? '未登录' : '已登录'}  ${p.name.padEnd(4)} -> ${href}`);
}
sock.close();
