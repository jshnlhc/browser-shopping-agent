# -*- coding: utf-8 -*-
"""分析 Product Comparison 数据集：人类比价时关注哪些属性"""
import re
import sys
from collections import Counter

path = sys.argv[1]
rows = []
with open(path, encoding='utf-8') as f:
    header = f.readline()
    for line in f:
        parts = line.rstrip('\n').split('\t')
        if len(parts) >= 3:
            rows.append(parts)

print(f"记录数: {len(rows)}")

# 属性名提取：'attr_name_productN': 'value'
attr_counter = Counter()
attr_words = Counter()
nv = []
for r in rows:
    attrs = re.findall(r"'([^']+?)_product(\d+)'\s*:\s*'([^']*)'", r[0])
    for name, pid, val in attrs:
        attr_counter[name.strip()] += 1
        nv.append((name.strip(), val.strip()))

print(f"属性名-值对: {len(nv)}")
print(f"唯一属性名: {len(attr_counter)}")

print("\n=== 最常见的 25 个比价属性 ===")
for name, c in attr_counter.most_common(25):
    print(f"  {c:6d}  {name}")

# 属性词频（拆词）
for name, c in attr_counter.items():
    for w in re.split(r'[\s/\-]+', name.lower()):
        if len(w) > 2:
            attr_words[w] += c
print("\n=== 属性关键词 Top 25 ===")
for w, c in attr_words.most_common(25):
    print(f"  {c:6d}  {w}")

# 值的类型分布
def valtype(v):
    v = v.lower()
    if re.search(r'\d', v):
        return 'numeric'
    if v in ('yes', 'no', 'true', 'false'):
        return 'boolean'
    return 'text'

tc = Counter(valtype(v) for _, v in nv)
print("\n=== 属性值类型分布 ===")
for k, c in tc.most_common():
    print(f"  {k:10s} {c:6d}  ({c/len(nv)*100:.1f}%)")

# 人类比较句中出现的比较动词
sent_words = Counter()
for r in rows:
    s = r[2].lower()
    for w in re.findall(r'\b(prefer|better|higher|lower|cheaper|more|less|best|worse|similar|compare|difference)\b', s):
        sent_words[w] += 1
print("\n=== 人类比价句中的比较词 ===")
for w, c in sent_words.most_common(12):
    print(f"  {c:6d}  {w}")
