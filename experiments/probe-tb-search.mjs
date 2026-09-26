// probe-tb-search.mjs — 探测淘宝/天猫搜索页的商品链接与页面结构
// 用法: node probe-tb-search.mjs <port> <keyword> [outJson]
const PORT = Number(process.argv[2] || 9335);
const KW = process.argv[3] || '手机膜';
const OUT = process.argv[4] || '';
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
  new Promise((res, rej) => { const id = ++bseq; bpend.set(id, { res, rej }); bsock.send(JSON.stringify({ id, method, params })); });

const { targetId } = await bsend('Target.createTarget', { url: 'about:blank' });
const list = await (await fetch(`${base}/json/list`)).json();
const t = list.find((x) => x.id === targetId);
const sock = new WebSocket(t.webSocketDebuggerUrl);
const pend = new Map();
let seq = 0;
sock.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); p(m); }
});
await new Promise((r) => sock.addEventListener('open', r, { once: true }));
const send = (method, params = {}) =>
  new Promise((res) => { const id = ++seq; pend.set(id, res); sock.send(JSON.stringify({ id, method, params })); });
const ev = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r?.result?.exceptionDetails) return 'EXC: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200);
  return r?.result?.result?.value;
};

if (process.argv[5] !== 'noview') {
  await send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 2600, deviceScaleFactor: 1, mobile: false });
  console.log('[视口覆盖已启用 1512x2600]');
} else {
  console.log('[视口覆盖已禁用，使用真实窗口视口]');
}
const TAB = process.argv[6] || '';   // mall = 只筛天猫
const url = `https://s.taobao.com/search?q=${encodeURIComponent(KW)}${TAB ? '&tab=' + TAB : ''}`;
console.log('导航到:', url);
await send('Page.navigate', { url });
await sleep(15000);
await ev('window.scrollTo(0, 1200)');
await sleep(4000);
await ev('window.scrollTo(0, 2600)');
await sleep(5000);

const title = await ev('document.title');
const href = await ev('location.href');
const len = await ev('document.body ? document.body.innerText.length : 0');
console.log(`标题: ${title}`);
console.log(`落地: ${href}`);
console.log(`正文长度: ${len}`);

const items = await ev(`JSON.stringify([...document.querySelectorAll('a')].map(a=>a.getAttribute('href')||'').filter(h=>/item\\.(taobao|tmall)\\.com/.test(h)).slice(0,20))`);
console.log('\n--- 含 item.taobao/tmall.com 的链接 ---');
console.log(items);

const dataAttrs = await ev(`JSON.stringify([...document.querySelectorAll('[data-itemid],[data-id],[data-nid]')].slice(0,10).map(e=>({tag:e.tagName, di:e.getAttribute('data-itemid'), did:e.getAttribute('data-id'), dn:e.getAttribute('data-nid')})))`);
console.log('\n--- data-itemid / data-id / data-nid ---');
console.log(dataAttrs);

console.log('\n--- 正文前 500 字 ---');
console.log(String(await ev('document.body ? document.body.innerText.slice(0,500) : ""')));

if (OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT, JSON.stringify({ keyword: KW, title, href, len, items: JSON.parse(items || '[]') }, null, 2), 'utf8');
  console.log('\n→ ' + OUT);
}
sock.close();
await bsend('Target.closeTarget', { targetId });
bsock.close();
process.exit(0);
