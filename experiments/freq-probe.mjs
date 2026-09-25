// freq-probe.mjs — 频控恢复曲线探测
// 用法: node freq-probe.mjs <port> <sku> <rounds> <intervalSec> [outJson]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9335);
const SKU = process.argv[3] || '100039278567';
const ROUNDS = Number(process.argv[4] || 12);
const INTERVAL = Number(process.argv[5] || 90) * 1000;
const OUT = process.argv[6] || 'D:\\dsh-desktop\\assets\\dsh-sessions\\data\\freq-recovery.json';
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const rows = [];
for (let i = 1; i <= ROUNDS; i++) {
  const t0 = Date.now();
  const { targetId } = await bsend('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`${base}/json/list`)).json();
  const t = list.find((x) => x.id === targetId);
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
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r?.result?.result?.value;
  };

  await send('Page.navigate', { url: `https://item.jd.com/${SKU}.html` });
  await sleep(11000);
  const title = String((await ev('document.title')) || '');
  const len = Number((await ev('document.body ? document.body.innerText.length : 0')) || 0);
  const attrs = Number((await ev(`document.querySelectorAll('div.Ptable-item, div.attribute li, [class*="Ptable"]').length`)) || 0);
  sock.close();
  await bsend('Target.closeTarget', { targetId });
  const elapsed = Math.round((Date.now() - t0) / 1000);
  const blocked = /频控|验证|抱歉|出错/.test(title) || len < 1500;
  const row = { round: i, at: new Date().toISOString(), title, len, attrs, elapsedSec: elapsed, blocked };
  rows.push(row);
  console.log(`[${i}/${ROUNDS}] ${row.at.slice(11, 19)}  len=${String(len).padStart(5)}  attrs=${attrs}  blocked=${blocked}  title=${title.slice(0, 30)}`);
  writeFileSync(OUT, JSON.stringify({ sku: SKU, intervalSec: INTERVAL / 1000, probes: rows }, null, 2), 'utf8');
  if (!blocked && i > 1) {
    console.log(`\n✅ 第 ${i} 轮恢复：距首次探测 ${(i - 1) * (INTERVAL / 1000)} 秒`);
    break;
  }
  if (i < ROUNDS) await sleep(INTERVAL);
}
console.log(`\n结果 → ${OUT}`);
bsock.close();
process.exit(0);
