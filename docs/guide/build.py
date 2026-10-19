"""Build the Mizaj Studio Arabic user guide page from guide.md."""

import html
import re
from pathlib import Path

import markdown

HERE = Path(__file__).parent
BRAND = HERE.parent.parent / "brand"
AR_DIGITS = str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩")


def mark_svg(uid: str) -> str:
    s = (BRAND / "logo-mark.svg").read_text(encoding="utf-8")
    s = re.sub(r"<title>.*?</title>", "", s)
    s = s.replace('id="halo"', f'id="halo{uid}"').replace(
        "url(#halo)", f"url(#halo{uid})"
    )
    s = s.replace('fill="#059669"', 'fill="var(--nib)"')
    s = s.replace('stroke="#059669"', 'stroke="var(--nib)"')
    s = s.replace('stroke="#D97706"', 'stroke="var(--shadda)"')
    s = s.replace(
        'width="512" height="512"', 'class="mark" aria-hidden="true" focusable="false"'
    )
    s = s.replace('role="img" aria-label="Mizaj mark"', "")
    return s


def wordmark_svg() -> str:
    s = (BRAND / "wordmark-ar.svg").read_text(encoding="utf-8")
    s = re.sub(r"<title>.*?</title>", "", s)
    s = re.sub(r"<defs>.*?</defs>", "", s)
    s = s.replace('fill="#0F172A"', 'fill="var(--ink)"').replace(
        'fill="#059669"', 'fill="var(--nib)"'
    )
    s = s.replace('width="756" height="623"', 'class="wordmark"')
    s = s.replace('aria-label="مِزَاج"', 'aria-label="مِزَاج"')
    return s


def slug(text: str, used: set[str]) -> str:
    base = re.sub(r"[^\w؀-ۿ]+", "-", text).strip("-") or "s"
    s, i = base, 2
    while s in used:
        s, i = f"{base}-{i}", i + 1
    used.add(s)
    return s


def build(md_text: str) -> tuple[str, list[dict]]:
    # Drop the document title and the intro quote: the page header replaces them.
    md_text = re.sub(r"\A# .*?\n", "", md_text)
    body = markdown.markdown(
        md_text, extensions=["tables", "fenced_code", "sane_lists"]
    )
    used: set[str] = set()
    toc: list[dict] = []

    def h2(m: re.Match) -> str:
        inner = m.group(1)
        txt = html.unescape(re.sub(r"<[^>]+>", "", inner))
        num = re.match(r"(\d+)\.\s*(.*)", txt)
        sid = slug(txt, used)
        if num:
            n, title = num.group(1), num.group(2)
            toc.append({"id": sid, "n": n, "title": title, "subs": []})
            return (
                f'</section><section class="chapter" id="{sid}" aria-labelledby="{sid}-h">'
                f'<header class="ch-head"><span class="medallion" aria-hidden="true">'
                f'<svg viewBox="0 0 100 100"><path d="M50 4 63 21 84 16 79 37 96 50 79 63 84 84 63 79 50 96 37 79 16 84 21 63 4 50 21 37 16 16 37 21Z"/></svg>'
                f"<b>{n.translate(AR_DIGITS)}</b></span>"
                f'<span class="ch-kicker">الفصل {n.translate(AR_DIGITS)}</span>'
                f'<h2 id="{sid}-h">{html.escape(title)}</h2></header>'
            )
        toc.append({"id": sid, "n": "", "title": txt, "subs": []})
        return (
            f'</section><section class="chapter intro" id="{sid}" aria-labelledby="{sid}-h">'
            f'<h2 id="{sid}-h">{inner}</h2>'
        )

    def h3(m: re.Match) -> str:
        inner = m.group(1)
        txt = html.unescape(re.sub(r"<[^>]+>", "", inner))
        sid = slug(txt, used)
        label = re.sub(r"^(\d+)\.(\d+)\s*", "", txt)
        num = re.match(r"^(\d+\.\d+)", txt)
        if toc:
            toc[-1]["subs"].append({"id": sid, "title": label})
        n = (
            f'<span class="sec-n">{num.group(1).translate(AR_DIGITS)}</span>'
            if num
            else ""
        )
        return f'<h3 id="{sid}">{n}{html.escape(label)}</h3>'

    body = re.sub(r"<h2>(.*?)</h2>", h2, body)
    body = re.sub(r"<h3>(.*?)</h3>", h3, body)
    body = re.sub(r"\A\s*</section>", "", body) + "</section>"
    if not body.lstrip().startswith("<section"):
        body = '<section class="chapter lead">' + body

    # Tables scroll inside their own box on phones.
    body = body.replace("<table>", '<div class="tw" tabindex="0"><table>').replace(
        "</table>", "</table></div>"
    )
    # Callouts: "try it yourself" and "notes/limits" paragraphs.
    body = re.sub(
        r"<p><strong>(اختبرها بنفسك|اختبره بنفسك|اختبر بنفسك|كيف تستخدمها|كيف تبدأ|كيف تبحث عن أي شيء)([^<]*)</strong>",
        r'<p class="try"><strong>\1\2</strong>',
        body,
    )
    body = re.sub(
        r"<p><strong>(ملاحظات|حدود|تنبيه|ملاحظة|فائدته)([^<]*)</strong>",
        r'<p class="note"><strong>\1\2</strong>',
        body,
    )
    body = body.replace("<strong>المتوقع", '<strong class="exp">المتوقع')
    body = re.sub(r'<p class="(try|note)">(.*?)</p>', card, body, flags=re.S)
    body = re.sub(r"<hr\s*/?>", "", body)
    return body, toc


ICON = {
    "try": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3"/><path d="M7.5 15h9"/></svg>',
    "note": '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></svg>',
}


def _steps(text: str) -> list[str] | None:
    """Split «1. … 2. … 3. …» into steps when the numbers run 1, 2, 3 …"""
    parts = re.split(r"(?:^|\s)(\d{1,2})\.\s+", " " + text)
    nums = parts[1::2]
    if (
        len(nums) < 2
        or nums != [str(i) for i in range(1, len(nums) + 1)]
        or parts[0].strip()
    ):
        return None
    return [p.strip() for p in parts[2::2]]


def card(m: re.Match) -> str:
    kind, inner = m.group(1), m.group(2).strip()
    head = re.match(r"<strong>(.*?)</strong>\s*", inner)
    title = re.sub(r"[:：]\s*$", "", head.group(1)) if head else ""
    rest = inner[head.end() :] if head else inner
    exp_re = re.compile(r'<strong class="exp">المتوقع:?</strong>:?\s*')
    steps = _steps(rest)
    if steps:
        items = []
        split: list[str] = []
        for st in steps:  # «4. صدّر … **المتوقع:** …» -> the step, then the expectation
            em = exp_re.search(st)
            if em and em.start() > 0:
                split += [st[: em.start()].strip(), st[em.start() :]]
            else:
                split.append(st)
        for st in split:
            em = exp_re.match(st)
            if em:
                items.append(
                    f'<li class="exp"><span class="lbl">المتوقع</span> {st[em.end():]}</li>'
                )
            else:
                items.append(f"<li>{st}</li>")
        body = '<ol class="steps">' + "".join(items) + "</ol>"
    else:
        em = exp_re.search(rest)
        if em:
            body = (
                f"<p>{rest[: em.start()].strip()}</p>"
                if rest[: em.start()].strip()
                else ""
            )
            body += f'<div class="expect"><span class="lbl">المتوقع</span><p>{rest[em.end():]}</p></div>'
        else:
            body = f"<p>{rest}</p>"
    return (
        f'<aside class="card {kind}"><div class="card-h"><span class="ic">{ICON[kind]}</span>'
        f"<b>{title}</b></div>{body}</aside>"
    )


def toc_html(toc: list[dict]) -> str:
    out = []
    for c in toc:
        n = (
            f'<span class="tn">{c["n"].translate(AR_DIGITS)}</span>'
            if c["n"]
            else '<span class="tn">✦</span>'
        )
        subs = "".join(
            f'<li><a href="#{s["id"]}">{html.escape(s["title"])}</a></li>'
            for s in c["subs"]
        )
        sub = f'<ol class="subs">{subs}</ol>' if subs else ""
        out.append(
            f'<li class="tc" data-id="{c["id"]}"><a class="tca" href="#{c["id"]}">{n}'
            f'<span class="tt">{html.escape(c["title"])}</span></a>{sub}</li>'
        )
    return '<ol class="toc">' + "".join(out) + "</ol>"


ONLINE_HEAD = (
    '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Amiri:wght@400;700'
    '&family=Cairo:wght@400;600;700&family=Noto+Naskh+Arabic:wght@400;600&display=swap">'
)
# Inside the app the guide opens offline in its own sandboxed window: nothing leaves the device.
OFFLINE_HEAD = (
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; '
    "style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:\">"
)
FONTS = [  # the app's own @fontsource fonts (OFL), embedded so the offline guide looks the same
    ("Amiri", "amiri", "arabic", 400),
    ("Amiri", "amiri", "arabic", 700),
    ("Cairo", "cairo", "arabic", 400),
    ("Cairo", "cairo", "arabic", 600),
    ("Cairo", "cairo", "arabic", 700),
    ("Cairo", "cairo", "latin", 400),
    ("Cairo", "cairo", "latin", 700),
]


def embedded_fonts() -> str:
    import base64

    root = HERE.parent.parent / "desktop" / "node_modules" / "@fontsource"
    out = []
    for family, pkg, subset, weight in FONTS:
        f = root / pkg / "files" / f"{pkg}-{subset}-{weight}-normal.woff2"
        if not f.exists():
            continue  # without desktop/node_modules the page falls back to system fonts
        b64 = base64.b64encode(f.read_bytes()).decode()
        out.append(
            f"@font-face{{font-family:'{family}';font-weight:{weight};font-display:swap;"
            f"src:url(data:font/woff2;base64,{b64}) format('woff2')}}"
        )
    return "<style>" + "".join(out) + "</style>" if out else ""


PAGES = {
    "guide": {
        "src": "guide.md",
        "title": "دليل مِزَاج ستوديو",
        "h1": "دليل المستخدم <span>الكامل</span>",
        "sub": "كل ميزة وكل خيار في البرنامج جزءاً جزءاً: ما هي، وفيم تفيدك، وكيف تفعّلها من "
        "الواجهة، وكيف تعمل من الداخل، وكيف تختبرها بنفسك بنص قصير ونتيجة متوقعة.",
        "switch": ("quick.html", "الدليل السريع"),
    },
    "quick": {
        "src": "quick.md",
        "title": "الدليل السريع لمِزَاج",
        "h1": "الدليل <span>السريع</span>",
        "sub": "كل ميزة في سطرين: فيم تفيدك وكيف تستخدمها. وللتفاصيل افتح الدليل الكامل.",
        "switch": ("guide.html", "الدليل الكامل"),
    },
}


def app_version() -> str:
    import json

    pkg = HERE.parent.parent / "desktop" / "package.json"
    return json.loads(pkg.read_text(encoding="utf-8"))["version"]


def render(name: str, version: str, offline: bool) -> str:
    cfg = PAGES[name]
    md = (HERE / cfg["src"]).read_text(encoding="utf-8").replace("{{VERSION}}", version)
    body, toc = build(md)
    chapters = len([c for c in toc if c["n"]])
    href, label = cfg["switch"]
    switch = f'<li><a href="{href}">{label} ←</a></li>' if offline else ""
    tpl = (HERE / "template.html").read_text(encoding="utf-8")
    return (
        tpl.replace(
            "{{HEAD}}", OFFLINE_HEAD + embedded_fonts() if offline else ONLINE_HEAD
        )
        .replace("{{TITLE}}", cfg["title"])
        .replace("{{H1}}", cfg["h1"])
        .replace("{{SUB}}", cfg["sub"])
        .replace("{{VERSION}}", version)
        .replace("{{SWITCH}}", switch)
        .replace("{{MARK_HERO}}", mark_svg("h"))
        .replace("{{MARK_NAV}}", mark_svg("n"), 1)
        .replace("{{MARK_NAV}}", mark_svg("f"))
        .replace("{{WORDMARK}}", wordmark_svg())
        .replace("{{TOC}}", toc_html(toc))
        .replace("{{BODY}}", body)
        .replace("{{CHAPTERS}}", str(chapters).translate(AR_DIGITS))
    )


def main() -> None:
    """build.py OUT_DIR [--offline] [--version X]: writes OUT_DIR/guide.html and quick.html."""
    import argparse

    ap = argparse.ArgumentParser()
    ap.add_argument("out", type=Path)
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--version", default=None)
    a = ap.parse_args()
    version = a.version or app_version()
    a.out.mkdir(parents=True, exist_ok=True)
    for name in PAGES:
        page = render(name, version, a.offline)
        (a.out / f"{name}.html").write_text(page, encoding="utf-8")
        print(a.out / f"{name}.html", len(page))


if __name__ == "__main__":
    main()
