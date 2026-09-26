// batch-attrs-tb.mjs — 批量抓淘宝商品详情页全文（存档，供离线解析）
// 用法: node batch-attrs-tb.mjs <port> <id1,id2,...> <intervalSec> <outDir>
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 9335);
const IDS = (process.argv[3] || '').split(',').map((s) => s.trim()).filter(Boolean);
const INTERVAL = Number(process.argv[4] || 120) * 1000;
const OUTDIR = process.argv[5] || 'D:\\dsh-desktop\\assets\\dsh-sessions\\data\\items';
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUTDIR, { recursive: true });

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

const rows = [];
for (let i = 0; i < IDS.length; i++) {
  const id = IDS[i];
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
    new Promise((res) => { const id2 = ++seq; pend.set(id2, res); sock.send(JSON.stringify({ id: id2, method, params })); });
  const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r?.result?.result?.value;
  };

  // 关键：不使用 Emulation.setDeviceMetricsOverride（实测触发淘宝风控）
  await send('Page.navigate', { url: `https://item.taobao.com/item.htm?id=${id}` });
  await sleep(16000);
  // 复刻 probe-tb-item.mjs 中成功的滚动方式：滚到页面中部并停住
  // （注意：不要滚到底部——参数区会被虚拟化渲染卸载，实测那样反而抓不到）
  for (let k = 0; k < 5; k++) { await ev('window.scrollBy(0, 1000)'); await sleep(1500); }
  await sleep(4000);

  const title = String((await ev('document.title')) || '');
  const url = String((await ev('location.href')) || '');
  // 放宽选择器：取 class 含 params 的容器里文本最长的一个（参数区通常是最大的一块）
  const params = await ev(`(() => {
    const cands = [...document.querySelectorAll('[class*="paramsInfoArea"], [class*="params"]')];
    let best = '';
    for (const c of cands) { const t = c.innerText || ''; if (t.length > best.length) best = t; }
    return best;
  })()`);
  const full = String((await ev('document.body ? document.body.innerText : ""')) || '');
  sock.close();
  await bsend('Target.closeTarget', { targetId });

  const blocked = /验证|加载中|抱歉/.test(title) || full.length < 600;
  const rec = { id, title, url, paramsLen: String(params).length, fullLen: full.length, blocked };
  rows.push(rec);
  const f = join(OUTDIR, `tb-${id}.txt`);
  writeFileSync(f, `ITEM: ${id}\nTITLE: ${title}\nURL: ${url}\n\n===PARAMS===\n${params}\n\n===FULL===\n${full}`, 'utf8');
  console.log(`[${i + 1}/${IDS.length}] ${id}  参数区=${rec.paramsLen}  全文=${rec.fullLen}  blocked=${blocked}`);
  console.log(`    ${title.slice(0, 60)}`);
  if (i < IDS.length - 1) await sleep(INTERVAL);
}
writeFileSync(join(OUTDIR, '_tb-index.json'), JSON.stringify(rows, null, 2), 'utf8');
console.log(`\n完成 ${rows.length} 个 → ${OUTDIR}`);
bsock.close();
process.exit(0);
