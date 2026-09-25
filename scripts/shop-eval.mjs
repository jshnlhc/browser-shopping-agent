// shop-eval.mjs — 在独立购物浏览器里按步骤执行任意 JS 表达式
// 用法: node shop-eval.mjs <url|-> <port> <waitAfterNavMs> <step1.js> [step2.js ...]
//   url = "-" 表示复用当前已打开的页面（不新建标签、不导航）
// 每个 step 文件是一段 JS 表达式（支持 async IIFE + await），结果按步骤打印
import { readFileSync } from 'node:fs';

const url = process.argv[2];
const PORT = Number(process.argv[3] || 9335);
const WAIT = Number(process.argv[4] || 12000);
const steps = process.argv.slice(5);
if (!url || steps.length === 0) {
  console.error('usage: node shop-eval.mjs <url|-> <port> <waitAfterNavMs> <step1.js> [step2.js ...]');
  process.exit(1);
}
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const between = 3000;

// ---- browser 级连接 ----
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

let targetId;
if (url === '-') {
  const list = await (await fetch(`${base}/json/list`)).json();
  const p = list.find((x) => x.type === 'page' && !x.url.startsWith('devtools://'));
  if (!p) {
    console.error('no existing page target; pass a real url');
    process.exit(1);
  }
  targetId = p.id;
  console.log(`reusing page: ${p.url}`);
} else {
  const r = await bsend('Target.createTarget', { url });
  targetId = r.targetId;
  console.log(`opened: ${url}`);
  await sleep(WAIT);
}

// ---- page 级连接 ----
const list2 = await (await fetch(`${base}/json/list`)).json();
const t = list2.find((x) => x.id === targetId);
if (!t) {
  console.error('target gone');
  process.exit(1);
}
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

for (let i = 0; i < steps.length; i++) {
  const f = steps[i];
  const expr = readFileSync(f, 'utf8');
  const r = await psend('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(`--- step${i + 1}: ${f} ---`);
  if (r?.result?.exceptionDetails) {
    console.log('EXCEPTION: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 600));
  }
  const v = r?.result?.result?.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v));
  if (i < steps.length - 1) await sleep(between);
}

psock.close();
bsock.close();
