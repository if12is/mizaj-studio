"""Build realistic, heavily formatted Arabic .docx files for export-fidelity checks."""
import base64
import subprocess
import sys
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_COLOR_INDEX
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Pt, RGBColor, Inches

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP8z4APMOGVHbHSAPAHAhGVgCHmAAAAAElFTkSuQmCC"
)
(OUT / "img.png").write_bytes(PNG)


def rtl_run(p, text, font="Simplified Arabic", size=14, bold=False, italic=False, color=None,
            underline=False, highlight=None):
    r = p.add_run(text)
    r.bold, r.italic, r.underline = bold, italic, underline
    r.font.size = Pt(size)
    r.font.name = font
    rpr = r._r.get_or_add_rPr()
    rf = rpr.get_or_add_rFonts()
    rf.set(qn("w:cs"), font)
    if bold:
        rpr.append(OxmlElement("w:bCs"))
    szcs = OxmlElement("w:szCs"); szcs.set(qn("w:val"), str(size * 2)); rpr.append(szcs)
    if color:
        r.font.color.rgb = RGBColor.from_string(color)
    if highlight:
        r.font.highlight_color = highlight
    rpr.append(OxmlElement("w:rtl"))
    return r


def bidi(p, align=WD_ALIGN_PARAGRAPH.RIGHT, before=6, after=6, line=1.5):
    p._p.get_or_add_pPr().insert(0, OxmlElement("w:bidi"))
    p.alignment = align
    pf = p.paragraph_format
    pf.space_before, pf.space_after, pf.line_spacing = Pt(before), Pt(after), line
    return p


def legal_memo(path):
    d = Document()
    sec = d.sections[0]
    sec._sectPr.append(OxmlElement("w:bidi"))
    # header / footer with Arabic + PAGE field
    hp = bidi(sec.header.paragraphs[0], WD_ALIGN_PARAGRAPH.CENTER)
    rtl_run(hp, "مكتب الأستاذ / محمد علي للمحاماه والاستشارات القانونيه", "Traditional Arabic", 12, True, color="1F4E79")
    fp = bidi(sec.footer.paragraphs[0], WD_ALIGN_PARAGRAPH.CENTER)
    rtl_run(fp, "صفحه ", size=10)
    fld = parse_xml(f'<w:fldSimple {nsdecls("w")} w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>')
    fp._p.append(fld)

    p = bidi(d.add_paragraph(), WD_ALIGN_PARAGRAPH.CENTER)
    rtl_run(p, "بسم الله الرحمن الرحيم", "Traditional Arabic", 20, True, color="C00000")
    p = bidi(d.add_paragraph())
    rtl_run(p, "محكمه استئناف الاسكندريه", "Simplified Arabic", 16, True, underline=True)
    rtl_run(p, " ", size=16)
    rtl_run(p, "مأموريه دمنهور", "Simplified Arabic", 16, False, italic=True)
    p = bidi(d.add_paragraph())
    rtl_run(p, "الدائره (11) مدني", size=14)
    p.add_run().add_tab()
    rtl_run(p, "مذكره بدفاع", size=14, bold=True, highlight=WD_COLOR_INDEX.YELLOW)
    p = bidi(d.add_paragraph())
    rtl_run(p, "السيد / وزير الداخليه وآخرين بصفاتهم", size=14, bold=True)
    br = p.add_run(); br.add_break()
    rtl_run(p, "ضد", size=14)
    p = bidi(d.add_paragraph(), WD_ALIGN_PARAGRAPH.JUSTIFY, line=2)
    rtl_run(p, "في الاستئناف رقم ", size=14)
    rtl_run(p, "3012", "Times New Roman", 14, bold=True)
    rtl_run(p, " لسنه 82 ق استئناف الاسكندريه مأموريه دمنهور والمحدد لنظره جلسه ", size=14)
    rtl_run(p, "22/11/2026", "Arial", 13, color="2E75B6")
    rtl_run(p, " .", size=14)
    # hyperlink + bookmark
    p = bidi(d.add_paragraph())
    bm_s = parse_xml(f'<w:bookmarkStart {nsdecls("w")} w:id="0" w:name="facts"/>')
    p._p.append(bm_s)
    rtl_run(p, "الوقائع", "Simplified Arabic", 16, True, underline=True)
    p._p.append(parse_xml(f'<w:bookmarkEnd {nsdecls("w")} w:id="0"/>'))
    rel = d.part.relate_to("https://example.com/law", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", is_external=True)
    hl = parse_xml(f'<w:hyperlink {nsdecls("w", "r")} r:id="{rel}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/><w:rtl/></w:rPr><w:t xml:space="preserve"> (راجع نص الماده) </w:t></w:r></w:hyperlink>')
    p._p.append(hl)
    for txt in [
        "اقام المستأنفين الدعوي رقم 494 لسنه 2025 مدني كلي حوش عيسي بموجب صحيفه طلبوا في ختامها الحكم .",
        "اولا : بالزام المدعي عليهم بان يؤدوا للمدعين مبلغ وقدره مليون جنيه كتعويض مادي وادبي ،",
        "ثانيا : الحكم عليهم ايضا متضامنين بان يؤدوا للمدعين مبلغ خمسمائه الف جنيه كتعويض موروث",
    ]:
        p = bidi(d.add_paragraph(style="List Number"), WD_ALIGN_PARAGRAPH.JUSTIFY)
        rtl_run(p, txt[:20], size=14, bold=True)
        rtl_run(p, txt[20:], size=14)
    # table with merged cells, shading, borders
    t = d.add_table(rows=3, cols=3)
    t.style = "Table Grid"
    tbl_pr = t._tbl.tblPr
    tbl_pr.append(OxmlElement("w:bidiVisual"))
    a = t.cell(0, 0).merge(t.cell(0, 1))
    for (r, c), txt in {(0, 0): "البيان", (0, 2): "المبلغ", (1, 0): "تعويض مادي", (1, 1): "عن الاضرار", (1, 2): "500000",
                         (2, 0): "تعويض ادبي", (2, 1): "عن الالام النفسيه", (2, 2): "250000"}.items():
        cell = t.cell(r, c)
        pp = bidi(cell.paragraphs[0], WD_ALIGN_PARAGRAPH.CENTER, 0, 0, 1)
        rtl_run(pp, txt, size=12, bold=(r == 0))
        if r == 0:
            shd = parse_xml(f'<w:shd {nsdecls("w")} w:val="clear" w:color="auto" w:fill="D9E2F3"/>')
            cell._tc.get_or_add_tcPr().append(shd)
    # image inline
    p = bidi(d.add_paragraph(), WD_ALIGN_PARAGRAPH.CENTER)
    p.add_run().add_picture(str(OUT / "img.png"), width=Inches(0.6))
    rtl_run(p, " الختم ", size=12)
    # page break + more text with tatweel, NBSP, RLM, Latin
    p = bidi(d.add_paragraph())
    p.add_run().add_break(WD_BREAK.PAGE)
    rtl_run(p, "الطلبــــات", "Traditional Arabic", 18, True, color="385623")
    p = bidi(d.add_paragraph(), WD_ALIGN_PARAGRAPH.JUSTIFY)
    rtl_run(p, "نلتمس من عداله المحكمه الحكم بقبول الاستئناف شكلا وفي الموضوع‏ برفضه ", size=14)
    rtl_run(p, "(Article 163)", "Calibri", 11, italic=True)
    rtl_run(p, " من القانون المدني مع الزام المستأنفين بالمصروفات ومقابل اتعاب المحاماه .", size=14)
    p = bidi(d.add_paragraph(), WD_ALIGN_PARAGRAPH.LEFT)
    rtl_run(p, "وكيل المستأنف ضده", "Simplified Arabic", 14, True)
    p.add_run().add_tab(); p.add_run().add_tab()
    rtl_run(p, "المحامي", size=14, bold=True)
    d.add_paragraph()  # empty trailing paragraph
    d.save(str(path))


FODT = """<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
<office:font-face-decls><style:font-face style:name="Traditional Arabic" svg:font-family="'Traditional Arabic'"/><style:font-face style:name="Simplified Arabic" svg:font-family="'Simplified Arabic'"/></office:font-face-decls>
<office:styles><style:style style:name="Standard" style:family="paragraph"><style:paragraph-properties style:writing-mode="rl-tb" fo:text-align="end"/><style:text-properties style:font-name-complex="Simplified Arabic" style:font-size-complex="14pt"/></style:style></office:styles>
<office:automatic-styles>
<style:style style:name="P1" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="center" fo:margin-top="0.2in" fo:line-height="150%"/></style:style>
<style:style style:name="P2" style:family="paragraph" style:parent-style-name="Standard"><style:paragraph-properties fo:text-align="justify" fo:text-indent="0.5in" fo:line-height="200%"/></style:style>
<style:style style:name="T1" style:family="text"><style:text-properties fo:color="#c00000" fo:font-weight="bold" style:font-weight-complex="bold" style:font-name-complex="Traditional Arabic" style:font-size-complex="18pt"/></style:style>
<style:style style:name="T2" style:family="text"><style:text-properties style:text-underline-style="solid" fo:background-color="#ffff00" style:font-style-complex="italic"/></style:style>
<style:style style:name="T3" style:family="text"><style:text-properties fo:color="#2e75b6" style:font-size-complex="12pt"/></style:style>
<style:style style:name="fr1" style:family="graphic"><style:graphic-properties fo:border="0.5pt solid #000000"/></style:style>
<style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="8.27in" fo:page-height="11.69in" style:writing-mode="rl-tb" fo:margin-top="1in" fo:margin-bottom="1in" fo:margin-left="1in" fo:margin-right="1.2in"/><style:header-style/><style:footer-style/></style:page-layout>
</office:automatic-styles>
<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1">
<style:header><text:p text:style-name="P1"><text:span text:style-name="T3">مذكرات الاستئناف - مكتب المحاماه</text:span></text:p></style:header>
<style:footer><text:p text:style-name="P1">صفحه <text:page-number text:select-page="current">1</text:page-number></text:p></style:footer>
</style:master-page></office:master-styles>
<office:body><office:text>
<text:p text:style-name="P1"><text:span text:style-name="T1">مذكره بدفاع المستأنف ضده</text:span></text:p>
<text:p text:style-name="P2">في الاستئناف المقيد برقم <text:span text:style-name="T2">2173 لسنه 82 ق</text:span> والخاص بعدم الزام اداره التنفيذ<text:note text:id="ftn1" text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>راجع حكم محكمه النقض في الطعن رقم 1774 لسنه 82 ق</text:p></text:note-body></text:note> بتراخيص البناء .</text:p>
<text:p text:style-name="P2"><draw:frame draw:style-name="fr1" draw:name="Frame1" text:anchor-type="paragraph" svg:width="2in"><draw:text-box><text:p>ملاحظه هامه داخل مربع نص</text:p></draw:text-box></draw:frame>ويحق للمستأنف ضده الدفع بعدم قبول الاستئناف لرفعه بعد الميعاد .</text:p>
<text:list><text:list-item><text:p text:style-name="P2">اولا : رفض الاستئناف</text:p></text:list-item><text:list-item><text:p text:style-name="P2">ثانيا : الزام المستأنف بالمصروفات</text:p></text:list-item></text:list>
<table:table table:name="T"><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell><text:p>رقم القضيه</text:p></table:table-cell><table:table-cell><text:p>تاريخ الجلسه</text:p></table:table-cell></table:table-row><table:table-row><table:table-cell><text:p>3408</text:p></table:table-cell><table:table-cell><text:p>15/12/2026</text:p></table:table-cell></table:table-row></table:table>
<text:p text:style-name="P2">وتفضلوا بقبول فائق الاحترام ،،،</text:p>
</office:text></office:body></office:document>
"""


def lo_memo(path):
    src = OUT / "lo_src.fodt"
    src.write_text(FODT, encoding="utf-8")
    subprocess.run(["soffice", "--headless", "--convert-to", "docx:MS Word 2007 XML", "--outdir", str(OUT), str(src)],
                   check=True, capture_output=True, timeout=180)
    (OUT / "lo_src.docx").rename(path)


legal_memo(OUT / "legal_memo.docx")
lo_memo(OUT / "lo_memo.docx")
print("ok")
