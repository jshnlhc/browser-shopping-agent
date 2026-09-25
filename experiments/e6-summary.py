# -*- coding: utf-8 -*-
"""汇总 E6（9 平台基线批次）数据，产出论文表格所需统计量"""
import json, sys, io, statistics as st
from collections import defaultdict

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

PATH = r'D:\dsh-desktop\assets\dsh-sessions\exp\batches\b2-20260925-220217.json'
d = json.load(open(PATH, encoding='utf-8'))

print("实验:", d['experiment'])
print("模式:", d['mode'])
print("门槛:", json.dumps(d['qualityGate'], ensure_ascii=False))
print(f"总观测: {d['totalObservations']}   质量分布: {d['qualityBreakdown']}")
ok = d['qualityBreakdown']['VALID'] / d['totalObservations']
print(f"有效数据率: {ok*100:.1f}%\n")

by = defaultdict(list)
for r in d['rows']:
    by[(r['pid'], r['platform'], r['domain'])].append(r)

print("=== 按平台汇总（仅 VALID 观测）===")
print(f"{'平台':<10}{'领域':<8}{'n':>3}{'文本长度 mean±sd':>22}{'请求数 mean':>12}{'命中商品 mean':>14}")
rows_out = []
for (pid, plat, dom), rs in sorted(by.items(), key=lambda x: -st.mean([r['textLen'] for r in x[1] if r['quality'] == 'VALID'] or [0])):
    v = [r for r in rs if r['quality'] == 'VALID']
    if not v:
        print(f"{plat:<10}{dom:<8}{0:>3}{'（无 VALID 观测）':>22}")
        rows_out.append({'platform': plat, 'pid': pid, 'domain': dom, 'n_valid': 0, 'n_total': len(rs)})
        continue
    tl = [r['textLen'] for r in v]
    rq = [r['requests'] for r in v]
    gm = [r['goodsMatches'] for r in v]
    mean = st.mean(tl)
    sd = st.stdev(tl) if len(tl) > 1 else 0.0
    print(f"{plat:<10}{dom:<8}{len(v):>3}{mean:>14.0f} ± {sd:<6.0f}{st.mean(rq):>12.0f}{st.mean(gm):>14.1f}")
    rows_out.append({'platform': plat, 'pid': pid, 'domain': dom, 'n_valid': len(v), 'n_total': len(rs),
                     'textLen_mean': round(mean), 'textLen_sd': round(sd),
                     'requests_mean': round(st.mean(rq)), 'goods_mean': round(st.mean(gm), 2)})

print("\n=== 非 VALID 观测明细 ===")
for r in d['rows']:
    if r['quality'] != 'VALID':
        print(f"  {r['platform']:<8}{r['keyword']:<8}len={r['textLen']:<6}req={r['requests']:<5}"
              f"verifyWall={r['verifyWall']}  quality={r['quality']}")

print("\n=== 门控判据分布 ===")
vc = sum(1 for r in d['rows'] if r['verifyWall'])
print(f"  触发验证墙的观测: {vc}/{d['totalObservations']}")
print(f"  summary 字段: {json.dumps(d.get('summary', {}), ensure_ascii=False)[:400]}")

json.dump(rows_out, open(r'D:\dsh-desktop\assets\dsh-sessions\data\e6-platform-summary.json', 'w', encoding='utf-8'),
          ensure_ascii=False, indent=2)
print("\n→ data\\e6-platform-summary.json")
