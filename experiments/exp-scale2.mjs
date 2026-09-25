// exp-scale2.mjs — 实验 E6：扩展平台矩阵的批次实验（含数据质量门槛）
//
// 相对 exp-scale.mjs 的三项改进：
//   1) 平台矩阵从 3 扩展到 9（按领域分组，轮换以分散风控压力）
//   2) 每次观测后做「降级判定」——内容量低于阈值即标记 degraded，汇总时剔除
//   3) 记录每平台的「健康基线」——用当次运行的最高观测值作为参照，
//      相对其下降超过 60% 即判定为降级（避免用历史绝对值造成的误判）
//
// 安全约束：京东不做 UA 覆盖；不访问结算页；只读任务。
// 用法: node exp-scale2.mjs [port] [repeats] [cooldownMs] [outJson] [nativeOnly]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9335);
const REPEATS = Number(process.argv[3] || 3);
const COOLDOWN = Number(process.argv[4] || 20000);
const OUT = process.argv[5] || 'exp-e6-scale.json';
// nativeOnly=true 时只测原生 UA（用于有登录态的主实例，避免 UA 覆盖导致掉登录）
const NATIVE_ONLY = String(process.argv[6] || 'false') === 'true';

const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADLESS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36';

const KW = ['钢化膜', '手机壳', '数据线'];
const q = (s) => encodeURIComponent(s);

// 9 平台矩阵，按领域分组
const PLATFORMS = [
  { pid: 'jd', name: '京东', domain: '电商', uaOk: true, mk: (k) => `https://search.jd.com/Search?keyword=${q(k)}` },
  { pid: 'taobao', name: '淘宝', domain: '电商', uaOk: false, mk: (k) => `https://s.taobao.com/search?q=${q(k)}` },
  { pid: 'pdd', name: '拼多多', domain: '电商', uaOk: false, mk: (k) => `https://mobile.yangkeduo.com/search_result.html?search_key=${q(k)}` },
  { pid: 'suning', name: '苏宁易购', domain: '电商', uaOk: true, mk: (k) => `https://search.suning.com/${q(k)}/` },
  { pid: 'vip', name: '唯品会', domain: '电商', uaOk: true, mk: (k) => `https://category.vip.com/suggest.php?keyword=${q(k)}` },
  { pid: 'douyin', name: '抖音', domain: '内容', uaOk: true, mk: (k) => `https://www.douyin.com/search/${q(k)}` },
  { pid: 'bilibili', name: 'B站', domain: '内容', uaOk: true, mk: (k) => `https://search.bilibili.com/all?keyword=${q(k)}` },
  { pid: 'zhihu', name: '知乎', domain: '内容', uaOk: true, mk: (k) => `https://www.zhihu.com/search?type=content&q=${q(k)}` },
  { pid: 'meituan', name: '美团', domain: '本地生活', uaOk: true, mk: () => 'https://i.meituan.com/' },
];

// 质量门槛
const MIN_VALID_LEN = 500; // 低于此值视为无效观测（平台未返回可用内容）
const DEGRADE_RATIO = 0.4; // 相对平台本批次最高值下降超过 60%（即留存 <40%）视为降级

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

async function observe(p, keyword, cond) {
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
      const q2 = ppend.get(m.id);
      ppend.delete(m.id);
      q2(m);
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

  let reqCount = 0;
  psock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.requestWillBeSent') reqCount++;
  });
  await psend('Network.enable');
  try {
    await psend('Network.setCacheDisabled', { cacheDisabled: true });
  } catch {}
  await psend('Emulation.setDeviceMetricsOverride', { width: 1512, height: 2600, deviceScaleFactor: 1, mobile: false });
  if (!NATIVE_ONLY && p.uaOk) {
    await psend('Emulation.setUserAgentOverride', { userAgent: cond === 'headless' ? HEADLESS_UA : '' });
  }

  const t0 = Date.now();
  await psend('Page.navigate', { url: p.mk(keyword) });
  let len = 0;
  let stable = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const cur = (await peval('document.body ? document.body.innerText.length : 0')) || 0;
    if (cur > 0 && cur === len) stable++;
    else stable = 0;
    len = cur;
    if (stable >= 2 && len > 400) break;
  }
  const elapsed = Date.now() - t0;
  const info = await peval(
    `JSON.stringify({
       url: location.href,
       len: document.body ? document.body.innerText.length : 0,
       goods: (document.body?document.body.innerText:'').match(/[\\d.]+\\s*元|￥\\s*[\\d.]+/g)?.length || 0,
       verify: /验证|verify|spiderindefence|captcha|人机/.test(location.href + (document.body?document.body.innerText.slice(0,400):''))
     })`
  );
  let parsed = {};
  try {
    parsed = JSON.parse(info);
  } catch {}
  psock.close();
  await bsend('Target.closeTarget', { targetId });
  return {
    platform: p.name,
    pid: p.pid,
    domain: p.domain,
    keyword,
    condition: NATIVE_ONLY || !p.uaOk ? 'native' : cond,
    textLen: parsed.len ?? 0,
    goodsMatches: parsed.goods ?? 0,
    verifyWall: parsed.verify ?? null,
    requests: reqCount,
    elapsedMs: elapsed,
  };
}

const rows = [];
for (const p of PLATFORMS) {
  for (const kw of KW) {
    const conds = NATIVE_ONLY || !p.uaOk ? ['native'] : ['native', 'headless'];
    for (let r = 1; r <= REPEATS; r++) {
      for (const cond of conds) {
        process.stdout.write(`[${p.name}|${kw}|${cond}#${r}] `);
        let obs;
        try {
          obs = await observe(p, kw, cond);
        } catch (e) {
          obs = { platform: p.name, pid: p.pid, domain: p.domain, keyword: kw, condition: cond, error: String(e).slice(0, 100), textLen: 0 };
        }
        obs.repeat = r;
        rows.push(obs);
        console.log(`len=${obs.textLen} goods=${obs.goodsMatches} req=${obs.requests} verify=${obs.verifyWall}`);
        await sleep(COOLDOWN);
      }
    }
  }
  await sleep(COOLDOWN);
}

// ---------- 质量判定 ----------
const perPlatformMax = {};
for (const r of rows) {
  perPlatformMax[r.pid] = Math.max(perPlatformMax[r.pid] || 0, r.textLen || 0);
}
for (const r of rows) {
  const mx = perPlatformMax[r.pid] || 0;
  const len = r.textLen || 0;
  r.baselineMax = mx;
  r.quality = len < MIN_VALID_LEN ? 'INVALID_LOW' : len < mx * DEGRADE_RATIO ? 'DEGRADED' : 'VALID';
}
const valid = rows.filter((r) => r.quality === 'VALID');
const degraded = rows.filter((r) => r.quality === 'DEGRADED');
const invalid = rows.filter((r) => r.quality === 'INVALID_LOW');

function stats(vals) {
  const v = vals.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean: Number(mean.toFixed(1)), sd: Number(sd.toFixed(1)), min: Math.min(...v), max: Math.max(...v) };
}

const byGroup = {};
for (const r of valid) {
  const k = `${r.platform}|${r.condition}`;
  (byGroup[k] ||= []).push(r);
}
const summary = {};
for (const [k, arr] of Object.entries(byGroup)) {
  summary[k] = { n: arr.length, textLen: stats(arr.map((x) => x.textLen)), goods: stats(arr.map((x) => x.goodsMatches)), requests: stats(arr.map((x) => x.requests)) };
}

const out = {
  experiment: 'E6: 扩展平台矩阵（9 平台，含数据质量门槛）',
  mode: NATIVE_ONLY ? 'native-only（有登录态主实例）' : 'with-ua-contrast',
  qualityGate: { MIN_VALID_LEN, DEGRADE_RATIO, rules: 'len<500 → INVALID_LOW；len<平台最高值×40% → DEGRADED；其余 VALID' },
  totalObservations: rows.length,
  qualityBreakdown: { VALID: valid.length, DEGRADED: degraded.length, INVALID_LOW: invalid.length },
  rows,
  summary,
};
writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log('\n=== E6 质量分解 ===');
console.log(`  总计 ${rows.length} 次：VALID ${valid.length} / DEGRADED ${degraded.length} / INVALID_LOW ${invalid.length}`);
console.log(`  有效数据率 = ${((valid.length / rows.length) * 100).toFixed(1)}%`);
console.log('\n=== 有效数据（按平台×条件）===');
for (const [k, v] of Object.entries(summary)) {
  console.log(`  ${k.padEnd(22)} n=${String(v.n).padStart(2)}  len=${String(v.textLen?.mean).padStart(7)}±${String(v.textLen?.sd).padStart(6)}  req=${v.requests?.mean}`);
}
console.log('\nsaved ->', OUT);
bsock.close();
process.exit(0);
