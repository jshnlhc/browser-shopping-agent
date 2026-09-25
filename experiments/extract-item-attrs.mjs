// extract-item-attrs.mjs — 用 DOM 结构化提取京东商品规格属性 + 评价标签
// 用法: node extract-item-attrs.mjs <port> <sku1,sku2,...> <intervalSec> <outJson>
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9335);
const SKUS = (process.argv[3] || '').split(',').map((s) => s.trim()).filter(Boolean);
const INTERVAL = Number(process.argv[4] || 75) * 1000;
const OUT = process.argv[5] || 'D:\\dsh-desktop\\assets\\dsh-sessions\\data\\jd-item-attrs.json';
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

async function session() {
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 2600, deviceScaleFactor: 1, mobile: false });
  return { send, ev, sock, targetId };
}

// 提取脚本：优先走京东规格参数容器，逐级回退
const EXTRACT = `(() => {
  const norm = s => (s || '').replace(/\\s+/g, ' ').trim();
  const out = { specs: [], groups: [], tags: [], blocked: false, title: document.title };

  if (/频控|验证/.test(document.title)) { out.blocked = true; return JSON.stringify(out); }

  // 1) 京东规格参数：div.Ptable-item（含 h3 分组 + dl 的 dt/dd）
  const items = [...document.querySelectorAll('div.Ptable-item, div[class*="Ptable-item"]')];
  for (const it of items) {
    const h3 = it.querySelector('h3');
    const group = norm(h3 ? h3.innerText : '');
    const dl = it.querySelector('dl');
    if (!dl) continue;
    const kids = [...dl.children];
    for (let i = 0; i < kids.length; i++) {
      if (kids[i].tagName === 'DT') {
        const k = norm(kids[i].innerText);
        const d = kids[i + 1] && kids[i + 1].tagName === 'DD' ? norm(kids[i + 1].innerText) : '';
        if (k) out.specs.push({ group, key: k, value: d });
      }
    }
  }

  // 2) 回退：老版 ul.parameter2 > li
  if (out.specs.length === 0) {
    for (const li of document.querySelectorAll('ul.parameter2 > li, .parameter2 li')) {
      const t = norm(li.innerText);
      const m = t.match(/^([^：:]{2,12})[：:]\\s*(.+)$/);
      if (m) out.specs.push({ group: '', key: m[1], value: m[2] });
    }
  }

  // 3) 回退：任意 dl 的 dt/dd（限定在页面下半部，避开推荐位）
  if (out.specs.length === 0) {
    for (const dl of document.querySelectorAll('dl')) {
      const kids = [...dl.children];
      for (let i = 0; i < kids.length - 1; i++) {
        if (kids[i].tagName === 'DT' && kids[i + 1].tagName === 'DD') {
          const k = norm(kids[i].innerText), v = norm(kids[i + 1].innerText);
          if (k && k.length < 20 && v) out.specs.push({ group: '', key: k, value: v });
        }
      }
    }
  }

  // 4) 评价标签维度（标签名 + 计数）
  const tagEls = document.querySelectorAll('[class*="tag"] li, [class*="Tag"] li, .tag-list li');
  for (const el of tagEls) {
    const t = norm(el.innerText);
    const m = t.match(/^(.+?)\\s*[\\s\\u00a0]*(\\d+)$/);
    if (m && m[1].length <= 20) out.tags.push({ tag: m[1], count: Number(m[2]) });
  }

  return JSON.stringify(out);
})()`;

const results = [];
for (let i = 0; i < SKUS.length; i++) {
  const sku = SKUS[i];
  const s = await session();
  await s.send('Page.navigate', { url: `https://item.jd.com/${sku}.html` });
  await sleep(12000);
  // 滚到底部触发规格参数渲染
  for (let k = 0; k < 6; k++) {
    await s.ev('window.scrollBy(0, 1200)');
    await sleep(1300);
  }
  await sleep(4000);
  let raw = await s.ev(EXTRACT);
  let data = {};
  try { data = JSON.parse(raw || '{}'); } catch { data = { error: 'parse fail' }; }

  // 若没拿到 specs 且未被频控，重试一次（回到顶部再来）
  if ((!data.specs || data.specs.length === 0) && !data.blocked) {
    await s.ev('window.scrollTo(0, 0)');
    await sleep(2500);
    for (let k = 0; k < 8; k++) { await s.ev('window.scrollBy(0, 1000)'); await sleep(1200); }
    await sleep(4000);
    const raw2 = await s.ev(EXTRACT);
    try {
      const d2 = JSON.parse(raw2 || '{}');
      if (d2.specs && d2.specs.length) data = d2;
    } catch {}
  }

  s.sock.close();
  await bsend('Target.closeTarget', { targetId: s.targetId });

  const rec = { sku, title: data.title || '', blocked: !!data.blocked, specCount: (data.specs || []).length, tagCount: (data.tags || []).length, specs: data.specs || [], tags: data.tags || [] };
  results.push(rec);
  console.log(`[${i + 1}/${SKUS.length}] ${sku}  specs=${rec.specCount}  tags=${rec.tagCount}  blocked=${rec.blocked}  ${String(rec.title).slice(0, 34)}`);
  if (rec.specCount) console.log('    ' + rec.specs.slice(0, 8).map((x) => `${x.key}=${String(x.value).slice(0, 16)}`).join(' | '));
  writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
  if (i < SKUS.length - 1) await sleep(INTERVAL);
}
console.log(`\n→ ${OUT}`);
bsock.close();
process.exit(0);
