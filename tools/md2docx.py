# -*- coding: utf-8 -*-
"""极简 Markdown -> DOCX（面向本文论文结构，够用即可）
用法: python md2docx.py <in.md> <out.docx>
"""
import re
import sys

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor

CN_BODY = "宋体"
CN_HEAD = "黑体"
EN_FONT = "Times New Roman"


def set_font(run, cn=CN_BODY, size=10.5, bold=False, italic=False, mono=False):
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    run.font.name = "Consolas" if mono else EN_FONT
    rpr = run._element.get_or_add_rPr()
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rf)
    ea = "Consolas" if mono else cn
    rf.set(qn("w:eastAsia"), ea)
    rf.set(qn("w:ascii"), "Consolas" if mono else EN_FONT)
    rf.set(qn("w:hAnsi"), "Consolas" if mono else EN_FONT)


def add_runs(par, text, cn=CN_BODY, size=10.5, base_bold=False):
    """处理 **粗体**、`代码`、[^n] 脚注标记"""
    text = re.sub(r"\[\^(\d+)\]", r"[\1]", text)  # 脚注 -> 普通上标编号
    parts = re.split(r"(\*\*.+?\*\*|`[^`]+`)", text)
    for p in parts:
        if not p:
            continue
        if p.startswith("**") and p.endswith("**") and len(p) > 4:
            set_font(par.add_run(p[2:-2]), cn=cn, size=size, bold=True)
        elif p.startswith("`") and p.endswith("`") and len(p) > 2:
            set_font(par.add_run(p[1:-1]), cn=cn, size=size - 0.5, mono=True)
        else:
            set_font(par.add_run(p), cn=cn, size=size, bold=base_bold)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    lines = open(src, encoding="utf-8").read().split("\n")
    doc = Document()

    st = doc.styles["Normal"]
    st.font.name = EN_FONT
    st.font.size = Pt(10.5)
    st.element.rPr.rFonts.set(qn("w:eastAsia"), CN_BODY)

    i = 0
    in_code = False
    code_buf = []
    while i < len(lines):
        ln = lines[i]

        # 代码块
        if ln.strip().startswith("```"):
            if in_code:
                p = doc.add_paragraph()
                p.paragraph_format.left_indent = Pt(14)
                p.paragraph_format.space_after = Pt(6)
                set_font(p.add_run("\n".join(code_buf)), size=8.5, mono=True)
                code_buf, in_code = [], False
            else:
                in_code = True
            i += 1
            continue
        if in_code:
            code_buf.append(ln)
            i += 1
            continue

        s = ln.rstrip()
        if not s.strip():
            i += 1
            continue

        # 分隔线
        if re.fullmatch(r"-{3,}", s.strip()):
            doc.add_paragraph()
            i += 1
            continue

        # 标题
        m = re.match(r"^(#{1,4})\s+(.*)$", s)
        if m:
            lvl = len(m.group(1))
            txt = re.sub(r"\[\^(\d+)\]", r"[\1]", m.group(2))
            h = doc.add_heading(level=min(lvl, 4))
            sizes = {1: 16, 2: 14, 3: 12, 4: 11}
            set_font(h.add_run(txt), cn=CN_HEAD, size=sizes.get(lvl, 11), bold=True)
            if lvl == 1:
                h.alignment = WD_ALIGN_PARAGRAPH.CENTER
            i += 1
            continue

        # 表格
        if s.strip().startswith("|") and i + 1 < len(lines) and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1]):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                if not re.match(r"^[\s:|-]+$", "|".join(cells)):
                    rows.append(cells)
                i += 1
            if rows:
                ncol = max(len(r) for r in rows)
                tbl = doc.add_table(rows=0, cols=ncol)
                tbl.style = "Table Grid"
                for ri, r in enumerate(rows):
                    cells = tbl.add_row().cells
                    for ci in range(ncol):
                        t = r[ci] if ci < len(r) else ""
                        par = cells[ci].paragraphs[0]
                        add_runs(par, t, size=9, base_bold=(ri == 0))
            continue

        # 列表
        m = re.match(r"^(\s*)[-*]\s+(.*)$", s)
        if m:
            p = doc.add_paragraph(style="List Bullet")
            p.paragraph_format.space_after = Pt(2)
            add_runs(p, m.group(2))
            i += 1
            continue
        m = re.match(r"^(\s*)(\d+)\.\s+(.*)$", s)
        if m:
            p = doc.add_paragraph(style="List Number")
            p.paragraph_format.space_after = Pt(2)
            add_runs(p, m.group(3))
            i += 1
            continue

        # 引用
        if s.strip().startswith(">"):
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Pt(20)
            add_runs(p, s.strip().lstrip(">").strip(), size=10)
            for r in p.runs:
                r.font.color.rgb = RGBColor(0x44, 0x44, 0x44)
                r.font.italic = True
            i += 1
            continue

        # 普通段落：连续行合并
        buf = [s.strip()]
        j = i + 1
        while j < len(lines):
            nx = lines[j].rstrip()
            if (not nx.strip() or nx.strip().startswith(("#", "|", ">", "-", "*", "```"))
                    or re.match(r"^\s*\d+\.\s", nx)):
                break
            buf.append(nx.strip())
            j += 1
        p = doc.add_paragraph()
        p.paragraph_format.first_line_indent = Pt(21)
        p.paragraph_format.space_after = Pt(6)
        add_runs(p, " ".join(buf))
        i = j

    doc.save(dst)
    print("saved:", dst)


if __name__ == "__main__":
    main()
