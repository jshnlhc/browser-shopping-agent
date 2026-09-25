// shop-login-check.mjs — 检查独立购物 profile 里各电商的登录态
// 用法: node shop-login-check.mjs [port] [-v]
// 只打印 cookie 名与条数，绝不打印 cookie 值
const PORT = Number(process.argv[2] || 9335);
const VERBOSE = process.argv.includes('-v');

const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const sock = new WebSocket(ver.webSocketDebuggerUrl);
const pending = new Map();
let seq = 0;

sock.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
  }
});
await new Promise((r) => sock.addEventListener('open', r, { once: true }));

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    sock.send(JSON.stringify({ id, method, params }));
  });

const { cookies } = await send('Storage.getCookies', {});

const SITES = [
  // must[] 全中才算已登录；must 为空的行只报 cookie 条数（无法判定）
  // 京东 Web 端已不用 pt_key/pt_pin 作判据（2026-09-24 实测：页面已登录但无此二者）
  // 更可靠的是 shop-login-probe.mjs 的「访问订单页是否被重定向」硬验证
  { name: '京东', host: 'jd.com', must: ['pin', 'thor'] },
  { name: '淘宝', host: 'taobao.com', must: ['unb'] },
  { name: '拼多多', host: 'yangkeduo.com', must: ['pdd_user_id'] },
  { name: '闲鱼', host: 'goofish.com', must: ['unb'] },
  { name: '抖音', host: 'douyin.com', must: ['sessionid'] },
  { name: '天猫', host: 'tmall.com', must: [] },
  { name: '得物', host: 'dewu.com', must: [] },
  { name: '唯品会', host: 'vip.com', must: [] },
];

console.log(`浏览器: ${ver.Browser}\n`);
for (const s of SITES) {
  const uniq = [...new Set(cookies.filter((c) => c.domain.includes(s.host)).map((c) => c.name))];
  const missing = s.must.filter((k) => !uniq.includes(k));
  const tag = s.must.length === 0 ? 'INFO ' : missing.length === 0 ? 'OK   ' : 'MISS ';
  console.log(
    `${tag} ${s.name.padEnd(4)} cookie ${String(uniq.length).padStart(3)} 条` +
      (missing.length ? `  缺少: ${missing.join(', ')}` : '')
  );
  if (VERBOSE) console.log('       ' + uniq.slice(0, 26).join(', '));
}
sock.close();
