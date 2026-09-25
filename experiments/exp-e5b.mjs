// exp-e5b.mjs — 实验 E5b：修正版跨平台泛化验证
// 修复 E5 自毁问题的三项措施：
//   1) 每次观测前 Network.clearBrowserCache（消除缓存导致的假阴性）
//   2) 每平台使用多个不同关键词（避免同一 URL 的累积降级）
//   3) 平台间冷却 + 降级检测（内容量相对首观测骤降即标记 degraded）
// 用法: node exp-e5b.mjs [port] [kwsPerPlatform] [cooldownMs] [outJson]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9336);
const KWS = Number(process.argv[3] || 3);
const COOLDOWN = Number(process.argv[4] || 15000);
const OUT = process.argv[5] || 'exp-e5b-multiplatform.json';
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADLESS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36';

const KEYWORDS = ['钢化膜', '手机壳', '数据线', '充电器', '蓝牙耳机'].slice(0, KWS);
const q = (s) => encodeURIComponent(s);

const PLATFORMS = [
  { pid: 'jd', name: '京东', domain: '电商', mk: (k) => `https://search.jd.com/Search?keyword=${q(k)}` },
  { pid: 'taobao', name: '淘宝', domain: '电商', mk: (k) => `https://s.taobao.com/search?q=${q(k)}` },
  { pid: 'suning', name: '苏宁易购', domain: '电商', mk: (k) => `https://search.suning.com/${q(k)}/` },
  { pid: 'vip', name: '唯品会', domain: '电商', mk: (k) => `https://category.vip.com/suggest.php?keyword=${q(k)}` },
  { pid: 'alibaba', name: '1688', domain: '电商', mk: (k) => `https://s.1688.com/selloffer/offer_search.htm?keywords=${q(k)}` },
  { pid: 'douyin', name: '抖音', domain: '内容', mk: (k) => `https://www.douyin.com/search/${q(k)}` },
  { pid: 'bilibili', name: 'B站', domain: '内容', mk: (k) => `https://search.bilibili.com/all?keyword=${q(k)}` },
  { pid: 'zhihu', name: '知乎', domain: '内容', mk: (k) => `https://www.zhihu.com/search?type=content&q=${q(k)}` },
];

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

async function observe(platform, keyword, cond) {
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

  await psend('Network.enable');
  // 措施 1：清缓存，避免命中缓存导致的假阴性
  try {
    await psend('Network.clearBrowserCache');
    await psend('Network.setCacheDisabled', { cacheDisabled: true });
  } catch {}
  await psend('Emulation.setDeviceMetricsOverride', { width: 1512, height: 2600, deviceScaleFactor: 1, mobile: false });
  await psend('Emulation.setUserAgentOverride', { userAgent: cond === 'headless' ? HEADLESS_UA : '' });

  await psend('Page.navigate', { url: platform.mk(keyword) });
  let len = 0;
  let stable = 0;
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const cur = (await peval('document.body ? document.body.innerText.length : 0')) || 0;
    if (cur > 0 && cur === len) stable++;
    else stable = 0;
    len = cur;
    if (stable >= 2 && len > 400) break;
  }
  const info = await peval(
    `JSON.stringify({
       url: location.href,
       len: document.body ? document.body.innerText.length : 0,
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
    platform: platform.name,
    pid: platform.pid,
    domain: platform.domain,
    keyword,
    condition: cond,
    textLen: parsed.len ?? 0,
    verifyWall: parsed.verify ?? null,
    finalUrl: parsed.url ?? '',
  };
}

const rows = [];
for (const p of PLATFORMS) {
  for (const kw of KEYWORDS) {
    for (const cond of ['native', 'headless']) {
      process.stdout.write(`[${p.name}|${kw}|${cond}] `);
      let obs;
      try {
        obs = await observe(p, kw, cond);
      } catch (e) {
        obs = { platform: p.name, pid: p.pid, domain: p.domain, keyword: kw, condition: cond, error: String(e).slice(0, 100) };
      }
      rows.push(obs);
      console.log(`len=${obs.textLen} verify=${obs.verifyWall}`);
      await sleep(COOLDOWN);
    }
  }
  await sleep(COOLDOWN * 2); // 平台间额外冷却
}

// ---------- 分析：按「关键词」配对，并检测降级 ----------
const report = [];
for (const p of PLATFORMS) {
  const prs = rows.filter((r) => r.pid === p.pid);
  const pairs = [];
  for (const kw of KEYWORDS) {
    const nat = prs.find((r) => r.keyword === kw && r.condition === 'native');
    const hed = prs.find((r) => r.keyword === kw && r.condition === 'headless');
    if (!nat || !hed) continue;
    pairs.push({
      keyword: kw,
      native: nat.textLen,
      headless: hed.textLen,
      drop: nat.textLen ? Number((1 - hed.textLen / nat.textLen).toFixed(4)) : null,
      valid: nat.textLen >= 500,
      degraded: nat.textLen < 500 && nat.textLen > 0,
    });
  }
  const valid = pairs.filter((x) => x.valid);
  const meanDrop = valid.length ? valid.reduce((a, b) => a + b.drop, 0) / valid.length : null;
  report.push({
    pid: p.pid,
    name: p.name,
    domain: p.domain,
    pairs,
    validPairs: valid.length,
    meanDrop: meanDrop === null ? null : Number(meanDrop.toFixed(4)),
    verdict:
      meanDrop === null
        ? 'INSUFFICIENT(无有效对照)'
        : meanDrop > 0.5
          ? 'STRONG(强检测)'
          : meanDrop > 0.15
            ? 'WEAK(弱)'
            : 'NONE(无差异)',
  });
}
report.sort((a, b) => (b.meanDrop ?? -9) - (a.meanDrop ?? -9));

const byDomain = ['电商', '内容'].map((dm) => {
  const rs = report.filter((r) => r.domain === dm && r.meanDrop !== null);
  return {
    domain: dm,
    validPlatforms: rs.length,
    strong: rs.filter((r) => r.verdict.startsWith('STRONG')).length,
    meanDrop: rs.length ? Number((rs.reduce((a, b) => a + b.meanDrop, 0) / rs.length).toFixed(4)) : null,
  };
});

const out = {
  experiment: 'E5b: 修正版跨平台泛化验证（清缓存 + 多关键词 + 降级检测）',
  fixes: ['Network.clearBrowserCache + setCacheDisabled', '每平台多个不同关键词', '平台间双倍冷却', '降级检测'],
  keywords: KEYWORDS,
  cooldownMs: COOLDOWN,
  totalObservations: rows.length,
  rows,
  report,
  byDomain,
};
writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log('\n=== E5b 报告 ===');
console.log('平台'.padEnd(12) + '领域'.padEnd(8) + '有效对'.padStart(7) + '平均下降'.padStart(11) + '  判定');
for (const r of report) {
  console.log(
    r.name.padEnd(12) + r.domain.padEnd(8) + String(r.validPairs).padStart(7) +
      (r.meanDrop === null ? '-' : (r.meanDrop * 100).toFixed(1) + '%').padStart(11) + '  ' + r.verdict
  );
}
console.log('\n--- 按领域 ---');
for (const d of byDomain) console.log(`  ${d.domain}: 有效平台=${d.validPlatforms} 强检测=${d.strong} 平均下降=${d.meanDrop === null ? 'n/a' : (d.meanDrop * 100).toFixed(1) + '%'}`);
console.log('\nsaved ->', OUT);
bsock.close();
process.exit(0);
