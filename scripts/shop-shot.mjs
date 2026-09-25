// shop-shot.mjs — 对购物浏览器里的某个标签页截图
// 用法: node shop-shot.mjs [port] <outPng> [urlOrTitleSubstring]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9335);
const out = process.argv[3];
const match = process.argv[4] || '';
if (!out) {
  console.error('usage: node shop-shot.mjs [port] <outPng> [urlOrTitleSubstring]');
  process.exit(1);
}
const base = `http://127.0.0.1:${PORT}`;

const list = await (await fetch(`${base}/json/list`)).json();
const pages = list.filter((x) => x.type === 'page');
const t = match
  ? pages.find((p) => p.url.includes(match) || (p.title || '').includes(match))
  : pages[0];
if (!t) {
  console.error('no matching target; pages:');
  pages.forEach((p) => console.error(' -', p.title, p.url));
  process.exit(1);
}
console.log('target:', t.title);
console.log('url   :', t.url);

const sock = new WebSocket(t.webSocketDebuggerUrl);
const pend = new Map();
let seq = 0;
sock.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id);
    pend.delete(m.id);
    p(m);
  }
});
await new Promise((r) => sock.addEventListener('open', r, { once: true }));
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++seq;
    pend.set(id, res);
    sock.send(JSON.stringify({ id, method, params }));
  });

const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
const data = r?.result?.data;
if (!data) {
  console.error('screenshot failed:', JSON.stringify(r).slice(0, 400));
  process.exit(1);
}
const buf = Buffer.from(data, 'base64');
writeFileSync(out, buf);
console.log(`saved -> ${out} (${buf.length} bytes)`);
sock.close();
