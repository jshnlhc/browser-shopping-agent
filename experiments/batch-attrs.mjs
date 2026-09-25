// batch-attrs.mjs — 多品类批量抓取商品详情页文本（用于跨语言属性对比）
// 用法: node batch-attrs.mjs [port] [outDir]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PORT = Number(process.argv[2] || 9335);
const OUTDIR = process.argv[3] || 'D:\\dsh-desktop\\assets\\dsh-sessions\\data\\items';
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUTDIR, { recursive: true });

// 多品类关键词（与 Prod-Comp 的品类覆盖尽量对齐：电子产品、家居、个护）
const KEYWORDS = ['钢化膜', '蓝牙耳机', '充电宝', '保温杯', '电动牙刷', '键盘', '鼠标'];

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

async function pageSession() {
  const { targetId } = await bsend('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`${base}/json/list`)).json();
  const t = list.find((x) => x.id === targetId);
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
  const peval = async (e) => {
    const r = await psend('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    return r?.result?.result?.value;
  };
  await psend('Emulation.setDeviceMetricsOverride', { width: 1512, height: 2600, deviceScaleFactor: 1, mobile: false });
  return { psend, peval, psock, targetId };
}

/** 从京东自营搜索页提取前 N 个商品 SKU */
async function findSkus(keyword, n = 2) {
  const s = await pageSession();
  await s.psend('Page.navigate', { url: `https://search.jd.com/Search?keyword=${encodeURIComponent(keyword)}` });
  await sleep(13000);
  await s.peval('window.scrollTo(0, document.body.scrollHeight)');
  await sleep(4000);
  // 京东搜索结果是 SPA：<a> 无 href，但每张商品卡片带 data-sku
  const raw = await s.peval(
    `JSON.stringify([...document.querySelectorAll('[data-sku]')].map(e=>e.getAttribute('data-sku')).filter(v=>/^\\d{6,}$/.test(v||'')))`
  );
  s.psock.close();
  await bsend('Target.closeTarget', { targetId: s.targetId });
  let skus = [];
  try {
    skus = JSON.parse(raw || '[]');
  } catch {}
  const uniq = [...new Set(skus)];
  // 首位通常是广告位（如京东京造），跳过它取真实自然结果
  return uniq.slice(uniq.length > n ? 1 : 0, uniq.length > n ? 1 + n : n);
}

/** 打开商品详情页，导出正文文本 */
async function dumpItem(sku, keyword) {
  const s = await pageSession();
  await s.psend('Page.navigate', { url: `https://item.jd.com/${sku}.html` });
  await sleep(16000);
  await s.peval(`(() => { const a=document.querySelector('div.attribute'); if(a) a.scrollIntoView({block:'center'}); else window.scrollTo(0,1800); })()`);
  await sleep(3000);
  for (let i = 0; i < 3; i++) {
    await s.peval('window.scrollBy(0, 900)');
    await sleep(1200);
  }
  await sleep(2000);
  const text = await s.peval('document.body ? document.body.innerText : ""');
  const title = await s.peval('document.title');
  s.psock.close();
  await bsend('Target.closeTarget', { targetId: s.targetId });
  return { sku, keyword, title: String(title).slice(0, 80), text: String(text) };
}

const results = [];
for (const kw of KEYWORDS) {
  console.log(`\n=== ${kw} ===`);
  let skus = [];
  try {
    skus = await findSkus(kw, 2);
  } catch (e) {
    console.log(`  搜索失败: ${String(e).slice(0, 80)}`);
  }
  console.log(`  找到 SKU: ${skus.join(', ') || '(无)'}`);
  for (const sku of skus) {
    try {
      const r = await dumpItem(sku, kw);
      writeFileSync(join(OUTDIR, `${kw}-${sku}.txt`), `SKU: ${sku}\nKEYWORD: ${kw}\nTITLE: ${r.title}\n\n${r.text}`, 'utf8');
      console.log(`  ✅ ${sku}  文本 ${r.text.length} 字符  → ${kw}-${sku}.txt`);
      results.push({ keyword: kw, sku, len: r.text.length, title: r.title });
    } catch (e) {
      console.log(`  ❌ ${sku}: ${String(e).slice(0, 80)}`);
    }
    await sleep(6000);
  }
  await sleep(8000);
}

writeFileSync(join(OUTDIR, '_index.json'), JSON.stringify(results, null, 2), 'utf8');
console.log(`\n合计抓取 ${results.length} 个商品 → ${OUTDIR}`);
bsock.close();
process.exit(0);
