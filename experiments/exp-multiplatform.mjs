// exp-multiplatform.mjs — 实验 E5：跨平台 UA 对照（泛化验证）
// 在独立临时 profile（未登录）上运行，不接触任何账号，因此可对所有平台做 UA 覆盖。
// 目的：检验「UA 检测是否为电商特有现象」——这是外部效度的关键测试。
// 用法: node exp-multiplatform.mjs [port] [repeats] [cooldownMs] [outJson]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9336);
const REPEATS = Number(process.argv[3] || 1);
const COOLDOWN = Number(process.argv[4] || 3000);
const OUT = process.argv[5] || 'exp-e5-multiplatform.json';
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADLESS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36';

const KW = encodeURIComponent('钢化膜');
const MATRIX = [
  { pid: 'jd', name: '京东', domain: '电商', url: `https://search.jd.com/Search?keyword=${KW}` },
  { pid: 'taobao', name: '淘宝', domain: '电商', url: `https://s.taobao.com/search?q=${KW}` },
  { pid: 'pdd', name: '拼多多', domain: '电商', url: `https://mobile.yangkeduo.com/search_result.html?search_key=${KW}` },
  { pid: 'suning', name: '苏宁易购', domain: '电商', url: `https://search.suning.com/${KW}/` },
  { pid: 'vip', name: '唯品会', domain: '电商', url: `https://category.vip.com/suggest.php?keyword=${KW}` },
  { pid: 'alibaba', name: '1688', domain: '电商', url: `https://s.1688.com/selloffer/offer_search.htm?keywords=${KW}` },
  { pid: 'douyin', name: '抖音', domain: '内容', url: `https://www.douyin.com/search/${KW}` },
  { pid: 'bilibili', name: 'B站', domain: '内容', url: `https://search.bilibili.com/all?keyword=${KW}` },
  { pid: 'zhihu', name: '知乎', domain: '内容', url: `https://www.zhihu.com/search?type=content&q=${KW}` },
  { pid: 'meituan', name: '美团', domain: '本地生活', url: 'https://i.meituan.com/' },
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

async function observe(cfg, cond) {
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

  await psend('Emulation.setDeviceMetricsOverride', { width: 1512, height: 2600, deviceScaleFactor: 1, mobile: false });
  await psend('Emulation.setUserAgentOverride', { userAgent: cond === 'headless' ? HEADLESS_UA : '' });

  await psend('Page.navigate', { url: cfg.url });
  let len = 0;
  let stable = 0;
  for (let i = 0; i < 10; i++) {
    await sleep(2000);
    const cur = (await peval('document.body ? document.body.innerText.length : 0')) || 0;
    if (cur > 0 && cur === len) stable++;
    else stable = 0;
    len = cur;
    if (stable >= 2 && len > 500) break;
  }
  await peval('window.scrollTo(0, document.body.scrollHeight)');
  await sleep(2000);

  const info = await peval(
    `JSON.stringify({
       url: location.href,
       title: document.title,
       len: document.body ? document.body.innerText.length : 0,
       verify: /验证|verify|spiderindefence|robot|captcha|人机/.test(location.href + (document.body?document.body.innerText.slice(0,400):''))
     })`
  );
  let parsed = {};
  try {
    parsed = JSON.parse(info);
  } catch {}
  psock.close();
  await bsend('Target.closeTarget', { targetId });
  return {
    platform: cfg.name,
    pid: cfg.pid,
    domain: cfg.domain,
    condition: cond,
    textLen: parsed.len ?? 0,
    verifyWall: parsed.verify ?? null,
    finalUrl: parsed.url ?? '',
  };
}

const rows = [];
for (const cfg of MATRIX) {
  for (let r = 1; r <= REPEATS; r++) {
    for (const cond of ['native', 'headless']) {
      process.stdout.write(`[${cfg.name}/${cond}#${r}] `);
      let obs;
      try {
        obs = await observe(cfg, cond);
      } catch (e) {
        obs = { platform: cfg.name, pid: cfg.pid, domain: cfg.domain, condition: cond, error: String(e).slice(0, 100) };
      }
      obs.repeat = r;
      rows.push(obs);
      console.log(`len=${obs.textLen} verify=${obs.verifyWall}`);
      await sleep(COOLDOWN);
    }
  }
}

// 汇总：按平台配对
const byPlatform = {};
for (const r of rows) {
  (byPlatform[r.pid] ||= { name: r.platform, domain: r.domain, runs: {} });
  (byPlatform[r.pid].runs[r.condition] ||= []).push(r);
}
const report = [];
for (const [pid, v] of Object.entries(byPlatform)) {
  const nat = v.runs.native || [];
  const hed = v.runs.headless || [];
  const mn = nat.length ? nat.reduce((a, b) => a + b.textLen, 0) / nat.length : 0;
  const mh = hed.length ? hed.reduce((a, b) => a + b.textLen, 0) / hed.length : 0;
  const drop = mn ? 1 - mh / mn : null;
  // 对照有效性：基线过低（未登录时平台不返回内容）时，UA 差异不可测 —— 标记为 INVALID 而非 NONE
  const VALID_BASELINE = 500;
  const valid = mn >= VALID_BASELINE;
  report.push({
    pid,
    name: v.name,
    domain: v.domain,
    nativeMean: Number(mn.toFixed(1)),
    headlessMean: Number(mh.toFixed(1)),
    dropRatio: drop === null ? null : Number(drop.toFixed(4)),
    contrastValid: valid,
    verdict: !valid
      ? 'INVALID(基线不足)'
      : drop > 0.5
        ? 'STRONG(强检测)'
        : drop > 0.15
          ? 'WEAK(弱)'
          : 'NONE(无差异)',
  });
}
report.sort((a, b) => (b.dropRatio ?? -9) - (a.dropRatio ?? -9));

const out = {
  experiment: 'E5: 跨平台 UA 对照（泛化验证，未登录临时 profile）',
  port: PORT,
  repeats: REPEATS,
  totalObservations: rows.length,
  rows,
  report,
  domainSummary: ['电商', '内容', '本地生活'].map((dm) => {
    const rs = report.filter((r) => r.domain === dm && r.dropRatio !== null && r.contrastValid);
    return {
      domain: dm,
      n: rs.length,
      strongDetect: rs.filter((r) => r.verdict.startsWith('STRONG')).length,
      meanDrop: rs.length ? Number((rs.reduce((a, b) => a + b.dropRatio, 0) / rs.length).toFixed(4)) : null,
    };
  }),
};
writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log('\n=== E5 报告（按检测强度排序）===');
console.log('平台'.padEnd(12) + '领域'.padEnd(10) + 'native'.padStart(9) + 'headless'.padStart(10) + 'drop'.padStart(9) + '  判定');
for (const r of report) {
  console.log(
    r.name.padEnd(12) + r.domain.padEnd(10) + String(r.nativeMean).padStart(9) + String(r.headlessMean).padStart(10) +
      (r.dropRatio === null ? '-' : (r.dropRatio * 100).toFixed(1) + '%').padStart(9) + '  ' + r.verdict
  );
}
console.log('\n--- 按领域 ---');
for (const d of out.domainSummary) console.log(`  ${d.domain}: n=${d.n} 强检测=${d.strongDetect} 平均下降=${(d.meanDrop * 100).toFixed(1)}%`);
console.log('\nsaved ->', OUT);
bsock.close();
process.exit(0);
