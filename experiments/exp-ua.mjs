// exp-ua.mjs — 实验 E1：UA 对照实验（检验 H2）
// 在同一浏览器实例、同一登录态下，比较正常 UA 与 HeadlessChrome UA 的渲染完整度。
// 安全性：仅访问淘宝搜索页（公开页面），绝不对京东做 UA 覆盖（会摧毁登录态，见 §6.3.1）。
// 用法: node exp-ua.mjs [port] [outJson]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9335);
const OUT = process.argv[3] || 'exp-e1-ua.json';
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TARGET_URL = 'https://s.taobao.com/search?q=%E9%92%A2%E5%8C%96%E8%86%9C';
const HEADLESS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36';

// ---------- browser 级连接 ----------
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
const list = await (await fetch(`${base}/json/list`)).json();
const t = list.find((x) => x.id === targetId);
if (!t) {
  console.error('target not found');
  process.exit(1);
}

// ---------- page 级连接 ----------
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
const peval = async (expr) => {
  const r = await psend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.result?.value;
};

// 视口放大（与主实验流程一致，避免混淆变量）
await psend('Emulation.setDeviceMetricsOverride', {
  width: 1512,
  height: 2600,
  deviceScaleFactor: 1,
  mobile: false,
});

/**
 * 在指定 UA 条件下加载页面并测量
 * @param {string|null} ua null = 使用浏览器原生 UA
 */
async function measure(label, ua) {
  if (ua) {
    await psend('Emulation.setUserAgentOverride', { userAgent: ua });
  } else {
    await psend('Emulation.setUserAgentOverride', { userAgent: '' });
  }
  await psend('Page.navigate', { url: TARGET_URL });
  // 轮询等待渲染稳定（最多 40 秒）
  let len = 0;
  let stable = 0;
  for (let i = 0; i < 20; i++) {
    await sleep(2000);
    const cur = (await peval('document.body ? document.body.innerText.length : 0')) || 0;
    if (cur > 0 && cur === len) stable++;
    else stable = 0;
    len = cur;
    if (stable >= 2 && len > 500) break;
  }
  const info = await peval(
    `JSON.stringify({
       url: location.href,
       title: document.title,
       len: document.body ? document.body.innerText.length : 0,
       effectiveUA: navigator.userAgent,
       hasGoods: /\\d+(\\.\\d+)?\\s*元|￥\\s*\\d+/.test(document.body ? document.body.innerText : ''),
       loginWall: /登录|请登录|扫码/.test((document.body ? document.body.innerText : '').slice(0, 400))
     })`
  );
  let parsed = {};
  try {
    parsed = JSON.parse(info);
  } catch {
    parsed = { raw: String(info).slice(0, 200) };
  }
  console.log(`[${label}] len=${parsed.len} url=${String(parsed.url).slice(0, 60)}`);
  return { label, uaUsed: ua || '(native)', ...parsed };
}

const results = [];
results.push(await measure('A_native_ua', null));
results.push(await measure('B_headless_ua', HEADLESS_UA));
// 恢复原生 UA 并复测，检验可逆性
results.push(await measure('C_restored_ua', null));

const summary = {
  experiment: 'E1: UA 对照实验（检验 H2）',
  target: TARGET_URL,
  hypothesis:
    'H2: 无头 UA 会导致渲染完整度显著下降（表现为页面文本长度大幅减少或商品信息缺失）',
  runs: results,
  derived: {
    nativeLen: results[0]?.len ?? null,
    headlessLen: results[1]?.len ?? null,
    restoredLen: results[2]?.len ?? null,
    dropRatio:
      results[0]?.len && results[1]?.len != null
        ? Number((1 - results[1].len / results[0].len).toFixed(4))
        : null,
    reversible:
      results[0]?.len != null && results[2]?.len != null
        ? Math.abs(results[0].len - results[2].len) / Math.max(results[0].len, 1) < 0.1
        : null,
  },
};

writeFileSync(OUT, JSON.stringify(summary, null, 2), 'utf8');
console.log('\n=== E1 结果 ===');
console.log(JSON.stringify(summary.derived, null, 2));
console.log('saved ->', OUT);

await bsend('Target.closeTarget', { targetId });
bsock.close();
process.exit(0);
