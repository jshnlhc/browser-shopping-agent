// exp-analyze.mjs — 跨批次数据汇总与统计
// 读取 exp-e4-scale.json 与 exp/batches/batch-*.json，合并所有观测并输出汇总统计。
// 用法: node exp-analyze.mjs [outJson]
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || join(here, 'exp-summary.json');

const sources = [];
const allRows = [];

function ingest(file, label) {
  if (!existsSync(file)) return;
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return;
  }
  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (!rows.length) return;
  sources.push({ file: file.replace(here, '.'), label, n: rows.length });
  for (const r of rows) allRows.push({ ...r, source: label });
}

// 主实验
ingest(join(here, 'exp-e4-scale.json'), 'E4');
// 分周期批次
const batchDir = join(here, 'batches');
if (existsSync(batchDir)) {
  for (const f of readdirSync(batchDir).filter((x) => x.endsWith('.json')).sort()) {
    ingest(join(batchDir, f), f.replace('batch-', '').replace('.json', ''));
  }
}

function stats(vals) {
  const v = vals.filter((x) => typeof x === 'number' && Number.isFinite(x));
  if (!v.length) return null;
  const n = v.length;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const sorted = [...v].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  return {
    n,
    mean: Number(mean.toFixed(1)),
    sd: Number(sd.toFixed(1)),
    median: Number(median.toFixed(1)),
    min: sorted[0],
    max: sorted[n - 1],
    cv: mean ? Number((sd / mean).toFixed(3)) : null,
  };
}

/** 独立双样本 Welch t 检验（小样本近似） */
function welchT(a, b) {
  const va = a.filter(Number.isFinite);
  const vb = b.filter(Number.isFinite);
  const n1 = va.length;
  const n2 = vb.length;
  if (n1 < 2 || n2 < 2) return null;
  const m1 = va.reduce((x, y) => x + y, 0) / n1;
  const m2 = vb.reduce((x, y) => x + y, 0) / n2;
  const s1 = va.reduce((x, y) => x + (y - m1) ** 2, 0) / (n1 - 1);
  const s2 = vb.reduce((x, y) => x + (y - m2) ** 2, 0) / (n2 - 1);
  const se = Math.sqrt(s1 / n1 + s2 / n2);
  if (se === 0) return { t: null, df: null, note: 'zero variance in both groups' };
  const t = (m1 - m2) / se;
  const df =
    Math.pow(s1 / n1 + s2 / n2, 2) /
    (Math.pow(s1 / n1, 2) / (n1 - 1) + Math.pow(s2 / n2, 2) / (n2 - 1));
  // Cohen's d（合并标准差）
  const sp = Math.sqrt(((n1 - 1) * s1 + (n2 - 1) * s2) / (n1 + n2 - 2));
  const d = sp ? (m1 - m2) / sp : null;
  return {
    t: Number(t.toFixed(3)),
    df: Number(df.toFixed(2)),
    cohensD: d === null ? null : Number(d.toFixed(3)),
    meanDiff: Number((m1 - m2).toFixed(1)),
    note: 'df<10 时 t 分布近似不可靠，此处仅作效应量参考',
  };
}

// 按 平台×条件 汇总
const groups = {};
for (const r of allRows) {
  const k = `${r.platform}|${r.condition}`;
  (groups[k] ||= []).push(r);
}

const summary = {};
for (const [k, rows] of Object.entries(groups)) {
  summary[k] = {
    n: rows.length,
    sources: [...new Set(rows.map((r) => r.source))],
    textLen: stats(rows.map((r) => r.textLen)),
    goodsMatches: stats(rows.map((r) => r.goodsMatches)),
    requests: stats(rows.map((r) => r.requests)),
    verifyWalls: rows.filter((r) => r.verifyWall === true).length,
  };
}

// 配对比较 + 检验
const comparisons = {};
for (const platform of [...new Set(allRows.map((r) => r.platform))]) {
  const nat = allRows.filter((r) => r.platform === platform && r.condition === 'native').map((r) => r.textLen);
  const hed = allRows.filter((r) => r.platform === platform && r.condition === 'headless').map((r) => r.textLen);
  if (nat.length < 2 || hed.length < 2) continue;
  const mn = nat.reduce((a, b) => a + b, 0) / nat.length;
  const mh = hed.reduce((a, b) => a + b, 0) / hed.length;
  comparisons[platform] = {
    nativeN: nat.length,
    headlessN: hed.length,
    nativeMean: Number(mn.toFixed(1)),
    headlessMean: Number(mh.toFixed(1)),
    dropRatio: mn ? Number((1 - mh / mn).toFixed(4)) : null,
    test: welchT(nat, hed),
  };
}

const out = {
  generatedAt: new Date().toISOString(),
  sources,
  totalObservations: allRows.length,
  summary,
  comparisons,
};
writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');

console.log(`数据源 ${sources.length} 个，合计 ${allRows.length} 次观测\n`);
console.log('平台|条件'.padEnd(24) + 'n'.padStart(4) + 'mean'.padStart(9) + 'sd'.padStart(9) + 'cv'.padStart(7) + '风控页'.padStart(8));
for (const [k, v] of Object.entries(summary)) {
  const t = v.textLen || {};
  console.log(
    k.padEnd(24) + String(v.n).padStart(4) + String(t.mean ?? '-').padStart(9) + String(t.sd ?? '-').padStart(9) +
      String(t.cv ?? '-').padStart(7) + String(v.verifyWalls).padStart(8)
  );
}
console.log('\n--- 配对比较 ---');
for (const [p, c] of Object.entries(comparisons)) {
  console.log(
    `${p}: native=${c.nativeMean}(n=${c.nativeN}) vs headless=${c.headlessMean}(n=${c.headlessN})  下降=${(c.dropRatio * 100).toFixed(2)}%  Cohen's d=${c.test?.cohensD ?? '-'}`
  );
}
console.log('\nsaved ->', OUT);
