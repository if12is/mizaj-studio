"""Turn real Word documents into Arabic ones: every w:t text is replaced by Arabic words of a
similar length (spaces and punctuation kept), so the real Word structure (rsids, proofErr,
fields, styles, headers, footnotes, text boxes) stays and the text is Arabic."""
import sys, zipfile, re
from pathlib import Path
from lxml import etree
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
WORDS = ["المحكمه","الاستئناف","الدعوي","المدعي","عليهم","بالزام","مبلغ","وقدره","تعويض","الاسكندريه","مذكره","بدفاع","لسنه","الحكم","المصروفات","اداره","التنفيذ","المحاماه","الدائره","مأموريه"]
src, dst = Path(sys.argv[1]), Path(sys.argv[2]); dst.mkdir(exist_ok=True)
for f in sorted(src.glob("*.docx")):
    k = 0
    def ar(m):
        global k
        k += 1
        return WORDS[k % len(WORDS)]
    out = dst / f"ar_{f.name}"
    with zipfile.ZipFile(f) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            data = zin.read(info)
            if info.filename.startswith("word/") and info.filename.endswith(".xml"):
                try:
                    root = etree.fromstring(data)
                    for t in root.iter(f"{{{W}}}t"):
                        if t.text: t.text = re.sub(r"[A-Za-z]+", ar, t.text)
                    data = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
                except etree.XMLSyntaxError:
                    pass
            zout.writestr(info, data)
    print(out.name)
