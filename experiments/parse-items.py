# -*- coding: utf-8 -*-
"""解析已抓取的京东商品详情页文本：SKU / 标题 / 评价标签维度 / 属性表存在性"""
import json, re, sys, io, pathlib

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

DIR = pathlib.Path(r'D:\dsh-desktop\assets\dsh-sessions\data\items')
out = []

for f in sorted(DIR.glob('*.txt')):
    raw = f.read_text(encoding='utf-8')
    lines = [l.strip() for l in raw.split('\n')]
    # 头部元信息
    meta = {}
    for l in lines[:4]:
        if l.startswith('SKU:'):
            meta['sku'] = l.split(':', 1)[1].strip()
        elif l.startswith('KEYWORD:'):
            meta['keyword'] = l.split(':', 1)[1].strip()
        elif l.startswith('TITLE:'):
            meta['title'] = l.split(':', 1)[1].strip()

    body = '\n'.join(lines)
    meta['len'] = len(raw)
    meta['blocked'] = ('频控' in meta.get('title', '')) or meta['len'] < 1500

    # 评价标签维度：位于「买家评价(N)」之后、「全部评价」之前，标签行与计数行交替
    tags = []
    m = re.search(r'买家评价\([^)]*\)(.*?)全部评价', body, re.S)
    if m:
        seg = [l for l in m.group(1).split('\n') if l.strip()]
        i = 0
        while i < len(seg) - 1:
            name, cnt = seg[i], seg[i + 1]
            if re.fullmatch(r'\d+', cnt.replace('\u00a0', '').strip()) and not re.fullmatch(r'\d+', name):
                tags.append({'tag': name, 'count': int(cnt)})
                i += 2
            else:
                i += 1

    # 属性表：京东规格参数区的常见键名
    ATTR_KEYS = ['品牌', '商品编号', '货号', '适用品牌', '适用机型', '材质', '工艺', '类型',
                 '包装清单', '颜色', '版本', '系列品', '型号', '商品毛重', '产地', '容量',
                 '电池容量', '接口', '连接方式', '续航时间', '防水等级', '降噪', '蓝牙版本']
    present = [k for k in ATTR_KEYS if re.search(r'^' + k + r'$', body, re.M)]
    meta['attr_keys_found'] = present
    meta['has_attr_table'] = len(present) >= 3

    meta['eval_tags'] = tags
    meta['tag_count'] = len(tags)
    out.append(meta)

    print(f"{f.name}")
    print(f"   sku={meta.get('sku')}  len={meta['len']}  blocked={meta['blocked']}  "
          f"attr_table={meta['has_attr_table']}({len(present)} keys)  eval_tags={len(tags)}")
    if tags:
        print('   标签: ' + ', '.join(f"{t['tag']}({t['count']})" for t in tags[:6]))
    print()

ok = [m for m in out if not m['blocked']]
print(f"合计 {len(out)} 个文件，有效 {len(ok)} 个，含属性表 {sum(1 for m in ok if m['has_attr_table'])} 个")

outfile = DIR / '_parsed.json'
outfile.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding='utf-8')
print(f"→ {outfile}")
