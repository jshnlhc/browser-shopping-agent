# -*- coding: utf-8 -*-
"""把 Prod-Comp(Amazon) 属性名归入语义族，输出族级分布 —— 供跨语言属性体系对比"""
import re, sys, io, json
from collections import Counter

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

FAMILIES = [
    ('RATING',        r'rating|score|review|star'),
    ('QUANTITY',      r'\bcount\b|number of|quantity|pack|pieces|set of|units'),
    ('PHYSICAL_SPEC', r'weight|capacity|size|dimension|length|width|height|volume|speed|'
                      r'power|watt|volt|battery|temperature|flow|pressure|thickness|'
                      r'memory|storage|resolution|frequency|rpm|diameter|area|depth'),
    ('IDENTITY',      r'brand|model|part number|manufacturer|item number|upc|asin|sku|'
                      r'series|edition|style name'),
    ('PRICE',         r'price|cost|value for money'),
    ('MATERIAL_LOOK', r'material|color|colour|finish|pattern|shape|texture|scent|flavor|taste'),
    ('COMPATIBILITY', r'compatib|fit|works with|for use'),
    ('PERFORMANCE',   r'durab|performance|ease of use|quality|effective|comfort|absorb|'
                      r'strength|stability|reliab|accuracy|efficien|noise|quiet|'
                      r'install|assembly|clean|hold|grip|protect'),
    ('FUNCTIONAL_SPEC', r'connectiv|interface|protocol|\bport|platform|method|feature|function|'
                        r'standard|refresh rate|transfer rate|brightness|maximum range|output|'
                        r'channel|tuner|security|resistan|included|duplex|batter|shipping|'
                        r'eaches|configuration|pesticide|marking'),
    ('PRODUCT_TYPE',  r'\btype\b|\bkind\b|category|form factor|\bstyle\b|design'),
]

def family_of(name):
    n = name.lower()
    for fam, pat in FAMILIES:
        if re.search(pat, n):
            return fam
    return 'OTHER'

path = r'D:\dsh-desktop\assets\dsh-sessions\data\prodcomp.tsv'
attr_counter = Counter()
rows = 0
with open(path, encoding='utf-8') as f:
    f.readline()
    for line in f:
        parts = line.rstrip('\n').split('\t')
        if len(parts) < 3:
            continue
        rows += 1
        for name, _pid, _val in re.findall(r"'([^']+?)_product(\d+)'\s*:\s*'([^']*)'", parts[0]):
            attr_counter[name.strip()] += 1

total = sum(attr_counter.values())
fam_counter = Counter()
fam_examples = {}
for name, c in attr_counter.items():
    fam = family_of(name)
    fam_counter[fam] += c
    fam_examples.setdefault(fam, []).append((c, name))

print(f"记录数 {rows}   属性-值对 {total}   唯一属性名 {len(attr_counter)}\n")
print("=== 英文(Amazon) 属性语义族分布 ===")
print(f"{'族':<16}{'次数':>8}{'占比':>9}   代表属性")
for fam, c in fam_counter.most_common():
    ex = ', '.join(n for _, n in sorted(fam_examples[fam], reverse=True)[:4])
    print(f"{fam:<16}{c:>8}{c/total*100:>8.1f}%   {ex[:78]}")

out = {
    'source': 'Product Comparison (WSDM 2023), attributes drawn from amazon.com product pages',
    'records': rows, 'attr_value_pairs': total, 'unique_attr_names': len(attr_counter),
    'families': {fam: {'count': c, 'share': round(c / total * 100, 2)} for fam, c in fam_counter.most_common()},
    'top_attrs': attr_counter.most_common(30),
}
with open(r'D:\dsh-desktop\assets\dsh-sessions\data\prodcomp-families.json', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
print("\n→ data\\prodcomp-families.json")

print("\n=== OTHER 族明细 Top 30（用于判断是否还有未识别的语义族） ===")
for c, name in sorted(fam_examples.get('OTHER', []), reverse=True)[:30]:
    print(f"  {c:5d}  {name}")
