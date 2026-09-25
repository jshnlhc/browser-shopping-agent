// exp-scale.mjs — 实验 E4：多平台 × 多条件 的规模化对照实验
// 目标：为 SCI 级别的实证研究积累样本量。
// 安全约束（硬性）：
//   1) 京东绝不执行 UA 覆盖（会摧毁登录态，见论文 §6.3.1）
//   2) 每次观测之间强制冷却（默认 20s），降低风控压力
//   3) 只读任务，不修改任何账号状态，不访问结算页
// 用法: node exp-scale.mjs [port] [repeats] [cooldownMs] [outJson]
import { writeFileSync, existsSync, readFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9335);
const REPEATS = Number(process.argv[3] || 3);
const COOLDOWN = Number(process.argv[4] || 20000);
const OUT = process.argv[5] || 'exp-e4-scale.json';
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HEADLESS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36';

// 条件矩阵：uaCover=false 表示不覆盖 UA（京东必须如此）
const MATRIX = [
  { pid: 'taobao', name: '淘宝', url: 'https://s.taobao.com/search?q=%E9%92%A2%E5%8C%96%E8%86%9C', uaCover: true },
  { pid: 'pdd', name: '拼多多', url: 'https://mobile.yangkeduo.com/search_result.html?search_key=%E9%92%A2%E5%8C%96%E8%86%9C', uaCover: true },
  { pid: 'jd', name: '京东', url: 'https://search.jd.com/Search?keyword=%E9%92%A2%E5%8C%96%E8%86%9C', uaCover: false },
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
  const useHeadless = cond === 'headless';
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

  let reqCount = 0;
  psock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.requestWillBeSent') reqCount++;
  });
  await psend('Network.enable');
  await psend('Emulation.setDeviceMetricsOverride', {
    width: 1512,
    height: 2600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (cfg.uaCover) {
    await psend('Emulation.setUserAgentOverride', { userAgent: useHeadless ? HEADLESS_UA : '' });
  }

  const t0 = Date.now();
  await psend('Page.navigate', { url: cfg.url });
  let len = 0;
  let stable = 0;
  for (let i = 0; i < 14; i++) {
    await sleep(2000);
    const cur = (await peval('document.body ? document.body.innerText.length : 0')) || 0;
    if (cur > 0 && cur === len) stable++;
    else stable = 0;
    len = cur;
    if (stable >= 2 && len > 800) break;
  }
  const elapsed = Date.now() - t0;

  const info = await peval(
    `JSON.stringify({
       url: location.href,
       len: document.body ? document.body.innerText.length : 0,
       goods: (document.body?document.body.innerText:'').match(/[\\d.]+\\s*元|￥\\s*[\\d.]+/g)?.length || 0,
       verifyWall: /identity_verify|verify\\.|spiderindefence|安全验证|身份验证/.test(location.href + (document.body?document.body.innerText.slice(0,500):''))
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
    condition: cfg.uaCover ? cond : 'native_only',
    textLen: parsed.len ?? 0,
    goodsMatches: parsed.goods ?? 0,
    verifyWall: parsed.verifyWall ?? null,
    finalUrl: parsed.url ?? '',
    requests: reqCount,
    elapsedMs: elapsed,
  };
}

const rows = [];
for (const cfg of MATRIX) {
  const conds = cfg.uaCover ? ['native', 'headless'] : ['native'];
  for (let r = 1; r <= REPEATS; r++) {
    for (const cond of conds) {
      process.stdout.write(`[${cfg.name}/${cond} #${r}] `);
      let obs;
      try {
        obs = await observe(cfg, cond);
      } catch (e) {
        obs = { platform: cfg.name, pid: cfg.pid, condition: cond, error: String(e).slice(0, 120) };
      }
      obs.repeat = r;
      rows.push(obs);
      console.log(`len=${obs.textLen} goods=${obs.goodsMatches} req=${obs.requests} wall=${obs.verifyWall}`);
      await sleep(COOLDOWN);
    }
  }
}

// ---------- 统计 ----------
function stats(arr) {
  const v = arr.filter((x) => typeof x === 'number' && !Number.isNaN(x));
  if (!v.length) return null;
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { n, mean: Number(mean.toFixed(1)), sd: Number(sd.toFixed(1)), min: Math.min(...v), max: Math.max(...v) };
}

const byKey = {};
for (const r of rows) {
  const k = `${r.platform}|${r.condition}`;
  if (!byKey[k]) byKey[k] = [];
  byKey[k].push(r);
}
const summary = {};
for (const [k, arr] of Object.entries(byKey)) {
  summary[k] = {
    textLen: stats(arr.map((x) => x.textLen)),
    goodsMatches: stats(arr.map((x) => x.goodsMatches)),
    requests: stats(arr.map((x) => x.requests)),
    verifyWalls: arr.filter((x) => x.verifyWall === true).length,
    n: arr.length,
  };
}

// 配对比较（同平台 native vs headless）
const paired = {};
for (const cfg of MATRIX) {
  if (!cfg.uaCover) continue;
  const nat = rows.filter((r) => r.platform === cfg.name && r.condition === 'native');
  const hed = rows.filter((r) => r.platform === cfg.name && r.condition === 'headless');
  if (!nat.length || !hed.length) continue;
  const natMean = nat.reduce((a, b) => a + b.textLen, 0) / nat.length;
  const hedMean = hed.reduce((a, b) => a + b.textLen, 0) / hed.length;
  paired[cfg.name] = {
    nativeMeanLen: Number(natMean.toFixed(1)),
    headlessMeanLen: Number(hedMean.toFixed(1)),
    dropRatio: natMean ? Number((1 - hedMean / natMean).toFixed(4)) : null,
  };
}

const out = {
  experiment: 'E4: 多平台 × 多条件 规模化对照实验',
  design: { repeats: REPEATS, cooldownMs: COOLDOWN, matrix: MATRIX.map((m) => ({ pid: m.pid, name: m.name, uaCover: m.uaCover })) },
  safety: ['京东不执行 UA 覆盖', '每次观测间隔 ' + COOLDOWN + 'ms', '仅只读任务'],
  rows,
  summary,
  paired,
};
writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
console.log('\n=== E4 汇总 ===');
console.log(JSON.stringify(summary, null, 2));
console.log('--- 配对比较 ---');
console.log(JSON.stringify(paired, null, 2));
console.log('saved ->', OUT);
bsock.close();
process.exit(0);
