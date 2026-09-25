# -*- coding: utf-8 -*-
"""从已保存的京东商品详情页文本离线解析**三段字段区**（不用再访问京东，规避频控/验证）。

页面结构（5 个商品实测一致）：
  A 规格参数表  —— 紧跟在**最后一处**「商品详情」之后；段内前截为「值在前、键在后」(高亮参数)，
                   自「品牌」/「商品编号」起为「键在前、值在后」
  B 销售变体    —— 「系列品」「颜色」「版本」，值是多行选项列表
  C 服务承诺    —— 「服务」，值是「·」分隔的履约承诺串
三段语义角色不同：A=产品固有属性，B=交易选项，C=履约承诺。
"""
import json, re, sys, io, pathlib
from collections import defaultdict

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

DIR = pathlib.Path(r'D:\dsh-desktop\assets\dsh-sessions\data\items')
A_STOP = ['到手价', '收藏', '累计评价', '送至', '降价通知', '已享受', '可再享', '开启桌面提醒',
          '立即购买', '产品数字标识', '政府补贴价', '补贴价', '日常价', '优选服务', '查看全部',
          '促销', '评价', '距离结束', '京 东 价']
B_HEADS = ['系列品', '颜色', '版本']
C_HEADS = ['服务']
C_STOP = ['优选服务', '立即购买', '新人到手价', '温馨提示', '展开全部', '首页', '加入购物车']


def parse(raw):
    pos = raw.rfind('商品详情')
    lines = [l.strip() for l in raw.split('\n')]
    lines = [l for l in lines if l]

    # ---------- A 规格参数表 ----------
    if pos < 0:
        return None
    tail = lines[[i for i, l in enumerate(lines) if l == '商品详情'][-1] + 1:]
    for i, l in enumerate(tail):
        if any(s in l for s in A_STOP):
            tail = tail[:i]
            break
    bi = next((i for i, l in enumerate(tail) if l in ('品牌', '商品编号') and i + 1 < len(tail)), None)
    specs = []
    if bi is not None:
        partA, partB = tail[:bi], tail[bi:]
        for i in range(0, len(partA) - 1, 2):
            v, k = partA[i], partA[i + 1]
            if k and len(k) <= 12 and not re.search(r'\d', k):
                specs.append({'key': k, 'value': v, 'section': 'A'})
        i = 0
        while i + 1 < len(partB):
            k, v = partB[i], partB[i + 1]
            if len(k) <= 20 and not re.search(r'\d', k):
                specs.append({'key': k, 'value': v, 'section': 'B'})
                i += 2
            else:
                i += 1

    # ---------- B 销售变体 ----------
    variants = {}
    for i, l in enumerate(lines):
        if l in B_HEADS:
            vals, j = [], i + 1
            while j < len(lines) and lines[j] not in B_HEADS + C_HEADS + C_STOP and not lines[j].startswith('¥'):
                vals.append(lines[j]); j += 1
            if vals and l not in variants:
                variants[l] = vals

    # ---------- C 服务承诺 ----------
    service = []
    for i, l in enumerate(lines):
        if l in C_HEADS:
            vals, j = [], i + 1
            while j < len(lines) and lines[j] not in C_STOP and lines[j] not in B_HEADS:
                vals.append(lines[j]); j += 1
            svc = [v for v in vals if v not in ('·', '-')]
            if len(svc) > len(service):
                service = svc

    return {'specs': specs, 'variants': variants, 'service': service}


out = []
for f in sorted(DIR.glob('*.txt')):
    raw = f.read_text(encoding='utf-8')
    if 'PC频控页' in raw or '京东验证' in raw or len(raw) < 1500:
        continue
    r = parse(raw)
    if not r or not r['specs']:
        continue
    meta = {}
    for l in raw.split('\n')[:4]:
        if ':' in l:
            k, v = l.split(':', 1)
            meta[k.strip()] = v.strip()
    rec = {'file': f.name, 'sku': meta.get('SKU', ''), 'keyword': meta.get('KEYWORD', ''), **r}
    out.append(rec)

    print(f"### {f.name}   SKU={rec['sku']}")
    print(f"  A 规格参数表（{len(r['specs'])} 项）")
    print('    ' + ' | '.join(f"{s['key']}={str(s['value'])[:20]}" for s in r['specs']))
    print(f"  B 销售变体：" + '；'.join(f"{k}×{len(v)}" for k, v in r['variants'].items()))
    print(f"  C 服务承诺（{len(r['service'])} 项）：" + ' / '.join(r['service'][:14]))
    print()

n = len(out)
print(f"=== 跨商品字段覆盖率（共 {n} 个商品）===")
cov = defaultdict(set)
for rec in out:
    for s in rec['specs']:
        cov[s['key']].add(rec['sku'])
for k, skus in sorted(cov.items(), key=lambda x: (-len(x[1]), x[0])):
    print(f"  {len(skus)}/{n}  {k}")

vcov = defaultdict(int)
for rec in out:
    for k in rec['variants']:
        vcov[k] += 1
print("\n=== 销售变体区字段覆盖率 ===")
for k, c in sorted(vcov.items(), key=lambda x: -x[1]):
    print(f"  {c}/{n}  {k}")
print(f"\n=== 服务承诺区：{sum(1 for r in out if r['service'])}/{n} 个商品有该区 ===")

json.dump({'items': out, 'spec_coverage': {k: sorted(v) for k, v in cov.items()},
           'shops': [r['sku'] for r in out]},
          open(r'D:\dsh-desktop\assets\dsh-sessions\data\jd-page-fields.json', 'w', encoding='utf-8'),
          ensure_ascii=False, indent=2)
print("\n→ data\\jd-page-fields.json")
