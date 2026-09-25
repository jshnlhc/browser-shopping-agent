// exp-matrix.mjs — 实验 E2：平台接入矩阵的标准化复现（T1 只读任务）
// 安全性：只访问公开列表/搜索页，绝不访问结算页（避免复现 §6.3.5 的风控升级）。
// 用法: node exp-matrix.mjs [port] [outJson]
import { writeFileSync } from 'node:fs';

const PORT = Number(process.argv[2] || 9335);
const OUT = process.argv[3] || 'exp-e2-matrix.json';
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEYWORD = encodeURIComponent('钢化膜');
const TARGETS = [
  { id: 'jd', name: '京东', url: `https://search.jd.com/Search?keyword=${KEYWORD}`, goods: /\d+\.\d+/ },
  { id: 'taobao', name: '淘宝/天猫', url: `https://s.taobao.com/search?q=${KEYWORD}`, goods: /[\d.]+\s*元|￥\s*[\d.]+/ },
  { id: 'pdd', name: '拼多多', url: `https://mobile.yangkeduo.com/search_result.html?search_key=${KEYWORD}`, goods: /[\d.]+\s*元|￥\s*[\d.]+/ },
  { id: 'douyin', name: '抖音(内容)', url: `https://www.douyin.com/search/${KEYWORD}`, goods: /#\S+/ },
  { id: 'suning', name: '苏宁易购', url: `https://search.suning.com/${KEYWORD}/`, goods: /[\d.]+\s*元|￥\s*[\d.]+/ },
  { id: 'meituan', name: '美团(到店)', url: 'https://i.meituan.com/', goods: /KTV|团购|到店/ },
];

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

async function probeTarget(cfg) {
  const { targetId } = await bsend('Target.createTarget', { url: 'about:blank' });
  const list = await (await fetch(`${base}/json/list`)).json();
  const t = list.find((x) => x.id === targetId);
  if (!t) return { id: cfg.id, name: cfg.name, error: 'target not found' };

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

  // 统计导航次数（PC 指标的一部分）
  let navCount = 0;
  let reqCount = 0;
  psock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Network.requestWillBeSent') reqCount++;
    if (m.method === 'Page.frameNavigated') navCount++;
  });
  await psend('Network.enable');
  await psend('Page.enable');
  await psend('Emulation.setDeviceMetricsOverride', {
    width: 1512,
    height: 2600,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await psend('Page.navigate', { url: cfg.url });
  let len = 0;
  let stable = 0;
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const cur = (await peval('document.body ? document.body.innerText.length : 0')) || 0;
    if (cur > 0 && cur === len) stable++;
    else stable = 0;
    len = cur;
    if (stable >= 2 && len > 800) break;
  }
  // 滚动一次以触发懒加载
  await peval('window.scrollTo(0, document.body.scrollHeight)');
  await sleep(2500);

  const info = await peval(
    `JSON.stringify({
       url: location.href,
       title: document.title,
       len: document.body ? document.body.innerText.length : 0,
       sessionHints: (document.body ? document.body.innerText : '').slice(0, 600),
       goodMatches: (document.body ? document.body.innerText : '').match(/[\\d.]+\\s*元|￥\\s*[\\d.]+/g)?.length || 0
     })`
  );
  let parsed = {};
  try {
    parsed = JSON.parse(info);
  } catch {
    parsed = { url: '(parse failed)', len: 0, title: '', goodMatches: 0, sessionHints: '' };
  }

  const text = parsed.sessionHints || '';
  const reachable = parsed.len > 800;
  const sessionSeen = /我的|订单|购物车|投稿|关注|退出|账号/.test(text);
  const goodsOk = cfg.goods.test(text) || (parsed.goodMatches || 0) > 0;
  const verdict =
    reachable && sessionSeen && goodsOk
      ? '通过'
      : reachable && goodsOk
        ? '部分通过(登录态未验证)'
        : reachable
          ? '仅可达(提取失败)'
          : '未通过';

  const row = {
    id: cfg.id,
    name: cfg.name,
    reachable,
    sessionSeen,
    goodsOk,
    verdict,
    finalUrl: parsed.url,
    title: parsed.title,
    textLen: parsed.len,
    goodsMatches: parsed.goodMatches || 0,
    navCount,
    reqCount,
  };
  console.log(
    `[${cfg.name}] 可达=${reachable} 登录态=${sessionSeen} 提取=${goodsOk} → ${verdict}  (len=${parsed.len}, req=${reqCount})`
  );
  psock.close();
  await bsend('Target.closeTarget', { targetId });
  return row;
}

const rows = [];
for (const cfg of TARGETS) {
  try {
    rows.push(await probeTarget(cfg));
  } catch (e) {
    rows.push({ id: cfg.id, name: cfg.name, error: String(e).slice(0, 150) });
    console.log(`[${cfg.name}] ERROR: ${String(e).slice(0, 100)}`);
  }
  await sleep(2000); // 平台间冷却，降低风控压力
}

const passed = rows.filter((r) => r.verdict === '通过').length;
const partial = rows.filter((r) => String(r.verdict).startsWith('部分')).length;
const summary = {
  experiment: 'E2: 平台接入矩阵标准化复现',
  criteria: {
    reachable: '渲染文本 > 800 字符',
    sessionSeen: '页面出现账号/订单/投稿等会话痕迹',
    goodsOk: '能解析出价格或结构化语义元素',
  },
  rows,
  aggregate: {
    total: rows.length,
    passed,
    partial,
    passRate: rows.length ? Number((passed / rows.length).toFixed(3)) : null,
  },
};
writeFileSync(OUT, JSON.stringify(summary, null, 2), 'utf8');
console.log('\n=== E2 汇总 ===');
console.log(JSON.stringify(summary.aggregate, null, 2));
console.log('saved ->', OUT);
bsock.close();
process.exit(0);
