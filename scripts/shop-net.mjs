// shop-net.mjs — 抓取页面 XHR/接口响应体（用于商品卡片不带链接的站点，如拼多多）
// 用法: node shop-net.mjs <url> <outfile> [port] [waitMs] [urlFilter]
// 关键点：Network.enable 必须在导航之前；getResponseBody 要在 loadingFinished 时立刻取（延后取会拿到空 body）
import { writeFileSync } from 'node:fs';

const url = process.argv[2];
const outFile = process.argv[3];
const PORT = Number(process.argv[4] || 9335);
const WAIT = Number(process.argv[5] || 15000);
const FILTER = process.argv[6] || '';
if (!url || !outFile) {
  console.error('usage: node shop-net.mjs <url> <outfile> [port] [waitMs] [urlFilter]');
  process.exit(1);
}
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- browser 级 ----
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

const { targetId } = await bsend('Target.createTarget', { url: 'about:blank' });
await sleep(1200);

const list = await (await fetch(`${base}/json/list`)).json();
const t = list.find((x) => x.id === targetId);
if (!t) {
  console.error('target not found');
  process.exit(1);
}

// ---- page 级 ----
const psock = new WebSocket(t.webSocketDebuggerUrl);
const ppend = new Map();
let pseq = 0;
const captured = [];
const bodies = new Map();

psock.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && ppend.has(m.id)) {
    const p = ppend.get(m.id);
    ppend.delete(m.id);
    p(m);
    return;
  }
  if (m.method === 'Network.responseReceived') {
    const r = m.params.response;
    if (!FILTER || r.url.includes(FILTER)) {
      captured.push({ requestId: m.params.requestId, url: r.url, status: r.status, mime: r.mimeType });
    }
  }
  if (m.method === 'Network.loadingFinished') {
    const id = m.params.requestId;
    if (captured.some((x) => x.requestId === id) && !bodies.has(id)) {
      psend('Network.getResponseBody', { requestId: id })
        .then((r) => {
          const b = r?.result?.body;
          if (b) bodies.set(id, b.length > 60000 ? b.slice(0, 60000) : b);
        })
        .catch(() => {});
    }
  }
});
await new Promise((r) => psock.addEventListener('open', r, { once: true }));
function psend(method, params = {}) {
  return new Promise((res) => {
    const id = ++pseq;
    ppend.set(id, res);
    psock.send(JSON.stringify({ id, method, params }));
  });
}

await psend('Network.enable');
await psend('Page.enable');
await psend('Page.navigate', { url });
await sleep(WAIT);
// 滚动一次触发懒加载
try {
  await psend('Runtime.evaluate', { expression: 'window.scrollTo(0, document.body.scrollHeight)' });
  await sleep(4000);
} catch {}

const out = captured.map((r) => ({ url: r.url, status: r.status, mime: r.mime, bodyLen: (bodies.get(r.requestId) || '').length, body: bodies.get(r.requestId) || '' }));
writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
console.log(`captured ${out.length} responses -> ${outFile}`);
for (const r of out.slice(0, 25)) console.log(`${r.status} [${r.bodyLen}] ${r.url.slice(0, 130)}`);
psock.close();
await bsend('Target.closeTarget', { targetId });
bsock.close();
