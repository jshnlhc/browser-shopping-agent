// exp-criteria.mjs — 实验 E3：判据层级验证（P1 只读 / P3 只读 / 登录态假阳性）
// 安全性：只读操作，不修改任何账号状态，不访问结算页。
// 用法: node exp-criteria.mjs [port] [outJson]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9335);
const OUT = process.argv[3] || 'exp-e3-criteria.json';
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

/** 打开页面并返回 { finalUrl, title, len, redirected } */
async function visit(url, waitMs = 12000) {
  const { targetId } = await bsend('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`${base}/json/list`)).json();
  const t = list.find((x) => x.id === targetId);
  if (!t) return { error: 'no target' };
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
  await psend('Emulation.setDeviceMetricsOverride', {
    width: 1512,
    height: 2600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await psend('Page.navigate', { url });
  await sleep(waitMs);
  const info = await peval(
    `JSON.stringify({ url: location.href, title: document.title, len: document.body?document.body.innerText.length:0 })`
  );
  let parsed = {};
  try {
    parsed = JSON.parse(info);
  } catch {}
  psock.close();
  await bsend('Target.closeTarget', { targetId });
  return { ...parsed, redirected: parsed.url !== url && !parsed.url.startsWith(url.split('?')[0]) };
}

/** 读取 cookie（只统计名称与数量，绝不读取值） */
async function cookieStats() {
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
  const r = await psend('Storage.getCookies');
  const cookies = r?.result?.cookies || [];
  const byDomain = {};
  for (const c of cookies) {
    const d = c.domain.replace(/^\./, '');
    byDomain[d] = (byDomain[d] || 0) + 1;
  }
  const jdNames = cookies.filter((c) => c.domain.includes('jd.com')).map((c) => c.name);
  psock.close();
  await bsend('Target.closeTarget', { targetId });
  return {
    total: cookies.length,
    jdCookieCount: jdNames.length,
    jdHasPin: jdNames.includes('pin'),
    jdHasThor: jdNames.includes('thor'),
    jdHasLegacyPtKey: jdNames.includes('pt_key'),
    topDomains: Object.entries(byDomain)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
  };
}

const results = { experiment: 'E3: 判据层级验证', steps: {} };

// ---------- P1：cookie 假阳性 vs 重定向测试 ----------
console.log('--- P1: 登录判据 ---');
const ck = await cookieStats();
console.log(`  cookie 快检: 总 ${ck.total} 条，jd.com 域 ${ck.jdCookieCount} 条（pin=${ck.jdHasPin}, thor=${ck.jdHasThor}, pt_key=${ck.jdHasLegacyPtKey}）`);
results.steps.cookieCheck = ck;

await sleep(3000);
const jdProtected = await visit('https://item.jd.com/100159918316.html', 14000);
const jdRedirected = /passport\.jd\.com|login/i.test(jdProtected.url || '');
console.log(`  重定向测试: 落地=${String(jdProtected.url).slice(0, 70)}`);
console.log(`    → 是否被重定向到登录页: ${jdRedirected}`);
console.log(`    → 页面文本长度: ${jdProtected.len}`);
results.steps.jdProtectedPage = { ...jdProtected, redirectedToLogin: jdRedirected };
results.steps.p1Verdict = {
  cookieSaysLoggedIn: ck.jdHasPin && ck.jdHasThor,
  redirectSaysLoggedIn: !jdRedirected,
  agreement:
    ck.jdHasPin && ck.jdHasThor ? (jdRedirected ? 'DISAGREE(cookie 假阳性)' : 'AGREE') : 'cookie 未命中，无法比较',
};

await sleep(3000);

// ---------- P3：购物车「商品总额 = 原价 × 件数」 ----------
console.log('\n--- P3: 购物车数量判据 ---');
const cart = await visit('https://cart.jd.com/cart_index', 16000);
const cartText = cart.len > 0;
results.steps.cart = { ...cart, hasContent: cartText };
console.log(`  购物车渲染: len=${cart.len} url=${String(cart.url).slice(0, 60)}`);
results.steps.p3Verdict = {
  note: '商品总额应等于各已勾选商品的原价×件数之和；到手价不可用于反推数量',
  cartRendered: cartText,
};

// ---------- 淘宝对照：确认是多平台现象还是京东特有 ----------
await sleep(3000);
console.log('\n--- 对照: 淘宝受保护页 ---');
const tbProtected = await visit('https://i.taobao.com/my_taobao.htm', 14000);
const tbRedirected = /login\.taobao\.com|login\.m\.taobao|passport/i.test(tbProtected.url || '');
console.log(`  落地=${String(tbProtected.url).slice(0, 70)}  重定向=${tbRedirected}  len=${tbProtected.len}`);
results.steps.taobaoProtectedPage = { ...tbProtected, redirectedToLogin: tbRedirected };

writeFileSync(OUT, JSON.stringify(results, null, 2), 'utf8');
console.log('\nsaved ->', OUT);
bsock.close();
process.exit(0);
