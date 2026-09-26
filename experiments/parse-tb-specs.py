# -*- coding: utf-8 -*-
"""离线解析淘宝/天猫商品详情页的「参数信息」区（结构与京东同型：前截值前键后，自锚点起键前值后）

数据来源：batch-attrs-tb.mjs 保存的 tb-<id>.txt（含 ===PARAMS=== 与 ===FULL=== 两段）
"""
import json, re, sys, io, pathlib
from collections import defaultdict

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

DIR = pathlib.Path(r'D:\dsh-desktop\assets\dsh-sessions\data\items')
ANCHORS = ['品牌', '商品编号', '货号', '型号', '产品参数']
STOP = ['参数信息', '立即购买', '加入购物车', '收藏', '客服', '分享']


def parse(params_text):
    lines = [l.strip() for l in params_text.split('\n')]
    lines = [l for l in lines if l]
    if lines and lines[0] == '参数信息':
        lines = lines[1:]
    bi = None
    for i, l in enumerate(lines):
        if l in ANCHORS and i + 1 < len(lines):
            bi = i
            break
    specs = []
    if bi is None:
        return specs, 'no-anchor'
    partA, partB = lines[:bi], lines[bi:]
    # 前截：值在前、键在后
    for i in range(0, len(partA) - 1, 2):
        v, k = partA[i], partA[i + 1]
        if k and len(k) <= 16:
            specs.append({'key': k, 'value': v, 'section': 'A'})
    # 后截：键在前、值在后
    i = 0
    while i + 1 < len(partB):
        k, v = partB[i], partB[i + 1]
        if len(k) <= 20 and k not in STOP:
            specs.append({'key': k, 'value': v, 'section': 'B'})
            i += 2
        else:
            i += 1
    return specs, 'ok'


out = []
for f in sorted(DIR.glob('tb-*.txt')):
    raw = f.read_text(encoding='utf-8')
    meta = {}
    for l in raw.split('\n')[:4]:
        if ':' in l:
            k, v = l.split(':', 1)
            meta[k.strip()] = v.strip()
    m = re.search(r'===PARAMS===\n(.*?)\n\n===FULL===', raw, re.S)
    if m:
        params_text = m.group(1)
    else:
        # 兼容 probe-tb-item.mjs 的存档格式：从全文里截取「参数信息」段
        i = raw.find('参数信息')
        if i < 0:
            continue
        seg = raw[i:]
        for stopw in ('立即购买', '加入购物车', '规则协议', '收藏'):
            j = seg.find(stopw)
            if j > 0:
                seg = seg[:j]
                break
        params_text = seg
    specs, note = parse(params_text)
    rec = {'file': f.name, 'id': meta.get('ITEM', ''), 'title': meta.get('TITLE', ''),
           'n_specs': len(specs), 'specs': specs, 'note': note}
    out.append(rec)
    print(f"### {f.name}  id={rec['id']}  属性 {len(specs)} 项（{note}）")
    print(f"  {rec['title'][:70]}")
    print('  ' + ' | '.join(f"{s['key']}={str(s['value'])[:22]}" for s in specs))
    print()

n = len(out)
cov = defaultdict(set)
for rec in out:
    for s in rec['specs']:
        cov[s['key']].add(rec['id'])
print(f"=== 淘宝跨商品字段覆盖率（共 {n} 个商品）===")
for k, ids in sorted(cov.items(), key=lambda x: (-len(x[1]), x[0])):
    print(f"  {len(ids)}/{n}  {k}")

allkeys = set(cov.keys())
print(f"\n总计 {len(allkeys)} 个不同字段；覆盖全部样本的字段：" +
      ', '.join(k for k, v in cov.items() if len(v) == n) or '（无）')

json.dump({'items': out, 'coverage': {k: sorted(v) for k, v in cov.items()}},
          open(r'D:\dsh-desktop\assets\dsh-sessions\data\tb-specs.json', 'w', encoding='utf-8'),
          ensure_ascii=False, indent=2)
print("\n→ data\\tb-specs.json")
