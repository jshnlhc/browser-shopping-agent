// probe-tb-item.mjs — 探测淘宝/天猫商品详情页的规格属性区结构
// 用法: node probe-tb-item.mjs <port> <itemId> [outTxt]
const PORT = Number(process.argv[2] || 9335);
const ID = process.argv[3] || '1059988523020';
const OUT = process.argv[4] || '';
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ver = await (await fetch(`${base}/json/version`)).json();
const bsock = new WebSocket(ver.webSocketDebuggerUrl);
const bpend = new Map();
let bseq = 0;
bsock.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && bpend.has(m.id)) { const p = bpend.get(m.id); bpend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
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

// 注意：不使用 Emulation.setDeviceMetricsOverride —— 实测它会触发淘宝风控
console.log('[未使用视口覆盖]');
await send('Page.navigate', { url: `https://item.taobao.com/item.htm?id=${ID}` });
await sleep(16000);
for (let i = 0; i < 5; i++) { await ev('window.scrollBy(0, 1000)'); await sleep(1500); }
await sleep(4000);

console.log('标题:', await ev('document.title'));
console.log('落地:', await ev('location.href'));
const len = await ev('document.body ? document.body.innerText.length : 0');
console.log('正文长度:', len);

// 多选择器试探属性区
const PROBE = `(() => {
  const out = {};
  const sel = ['#J_AttrUL', '#J_AttrUL li', '.attributes-list', '.attributes-list li',
               '[class*="attributes"] li', '[class*="Attribute"] li', '[class*="attrs"] li',
               'ul[class*="param"] li', '[class*="Param"] li', '.tm-attributes li', 'dl', 'dt', 'dd'];
  for (const s of sel) { try { out[s] = document.querySelectorAll(s).length; } catch(e) { out[s] = 'err'; } }
  // 抓取可能的键值对容器
  const box = document.querySelector('#J_AttrUL, .attributes-list, [class*="attributes"], [class*="Attribute"], [class*="params"]');
  out._boxFound = !!box;
  out._boxClass = box ? String(box.className).slice(0,80) : '';
  out._boxText = box ? box.innerText.slice(0, 900) : '';
  return JSON.stringify(out);
})()`;
console.log('\n--- 选择器试探 ---');
console.log(await ev(PROBE));

const text = String(await ev('document.body ? document.body.innerText : ""'));
if (OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT, `ITEM: ${ID}\nTITLE: ${await ev('document.title')}\n\n${text}`, 'utf8');
  console.log('\n全文 → ' + OUT + `  (${text.length} 字符)`);
}
console.log('\n--- 正文 1500-3200 字（通常属性区在此段）---');
console.log(text.slice(1500, 3200));

sock.close();
await bsend('Target.closeTarget', { targetId });
bsock.close();
process.exit(0);
