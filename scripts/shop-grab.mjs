// shop-grab.mjs — 打开页面 → 放大视口 → 滚动触发懒加载 → dump 可见文本
// 用法: node shop-grab.mjs <url> <outfile> [port] [waitMs] [scrollTimes]
// 相比 shop-dump.mjs 增加：Emulation 放大视口 + 多次滚动（对付淘宝这类懒加载列表）
import { writeFileSync } from 'node:fs';

const url = process.argv[2];
const outFile = process.argv[3];
const PORT = Number(process.argv[4] || 9335);
const WAIT = Number(process.argv[5] || 12000);
const SCROLLS = Number(process.argv[6] || 4);
if (!url || !outFile) {
  console.error('usage: node shop-grab.mjs <url> <outfile> [port] [waitMs] [scrollTimes]');
  process.exit(1);
}
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- browser 级连接 ----
const ver = await (await fetch(`${base}/json/version`)).json();
const bsock = new WebSocket(ver.webSocketDebuggerUrl);
const bpend = new Map();
let bseq = 0;
bsock.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && bpend.has(m.id)) {
    const p = bpend.get(m.id);
    bpend.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
});
await new Promise((r) => bsock.addEventListener('open', r, { once: true }));
const bsend = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++bseq;
    bpend.set(id, { res, rej });
    bsock.send(JSON.stringify({ id, method, params }));
  });

const { targetId } = await bsend('Target.createTarget', { url });
await sleep(WAIT);

// ---- page 级连接 ----
const list = await (await fetch(`${base}/json/list`)).json();
const t = list.find((x) => x.id === targetId);
let text = '';
let notes = [];
if (t) {
  const psock = new WebSocket(t.webSocketDebuggerUrl);
  const ppend = new Map();
  let pseq = 0;
  psock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && ppend.has(m.id)) {
      const p = ppend.get(m.id);
      ppend.delete(m.id);
      p(m);
    }
  });
  await new Promise((r) => psock.addEventListener('open', r, { once: true }));
  const psend = (method, params = {}) =>
    new Promise((res) => {
      const id = ++pseq;
      ppend.set(id, res);
      psock.send(JSON.stringify({ id, method, params }));
    });
  const peval = async (expression) => {
    const r = await psend('Runtime.evaluate', { expression, returnByValue: true });
    return r?.result?.result?.value;
  };

  // 放大视口（一次性多加载一批）
  try {
    await psend('Emulation.setDeviceMetricsOverride', {
      width: 1512,
      height: 2600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    notes.push('viewport 1512x2600');
  } catch (e) {
    notes.push('viewport override failed');
  }
  await sleep(3000);

  // 滚动触发懒加载
  let lastLen = 0;
  for (let i = 0; i < SCROLLS; i++) {
    await peval('window.scrollTo(0, document.body.scrollHeight)');
    await sleep(2600);
    const len = (await peval('document.body ? document.body.innerText.length : 0')) || 0;
    notes.push(`scroll#${i + 1} len=${len}`);
    if (len === lastLen && i >= 2) break; // 不再增长就停
    lastLen = len;
  }

  for (let i = 0; i < 4; i++) {
    text = (await peval('document.body ? document.body.innerText : ""')) || '';
    if (text.length > 800) break;
    await sleep(3000);
  }
  psock.close();
}

writeFileSync(outFile, `URL: ${t?.url || url}\nTITLE: ${t?.title || ''}\nSTEPS: ${notes.join(' | ')}\n\n${text}`, 'utf8');
console.log(`dumped ${text.length} chars -> ${outFile}`);
console.log(`steps: ${notes.join(' | ')}`);
console.log(`final url: ${t?.url || '(gone)'}`);
await bsend('Target.closeTarget', { targetId });
bsock.close();
