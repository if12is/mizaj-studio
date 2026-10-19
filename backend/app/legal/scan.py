"""Position-preserving Arabic scanning helpers shared by the case card and the date/article checks.

`Folded` builds a matching text that is tolerant of diacritics, tatweel, hamza forms,
alef maqsura / ya, ta marbuta, Arabic-Indic and Persian digits, and bidi marks, while keeping a
map back to the original code-point offsets. Nothing here ever rewrites the user's text: the
folded string is only a search key.
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass

_FOLD = str.maketrans(
    {
        "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ة": "ه", "ؤ": "و", "ئ": "ي",
        **{chr(0x660 + i): str(i) for i in range(10)},  # Arabic-Indic
        **{chr(0x6F0 + i): str(i) for i in range(10)},  # Persian
    }
)  # fmt: skip
# marks, dagger alef, tatweel, bidi / zero-width controls
_DROP = set("ًٌٍَُِّْٰـ") | set(chr(c) for c in range(0x064B, 0x0653))
_DROP |= set("​‌‍‎‏‪‫‬‭‮⁦⁧⁨⁩")


class Folded:
    """`f` is the folded text; `span(fs, fe)` maps a folded range to original offsets."""

    def __init__(self, text: str) -> None:
        self.text = text
        out: list[str] = []
        idx: list[int] = []
        for i, ch in enumerate(text):
            if ch in _DROP:
                continue
            if ch != "\n" and ch.isspace():
                ch = " "
            out.append(ch.translate(_FOLD))
            idx.append(i)
        self.f = "".join(out)
        self.idx = idx

    def span(self, fs: int, fe: int) -> tuple[int, int]:
        if not self.idx:
            return 0, 0
        fs = min(max(fs, 0), len(self.idx) - 1)
        if fe <= fs:
            return self.idx[fs], self.idx[fs]
        return self.idx[fs], self.idx[min(fe, len(self.idx)) - 1] + 1

    def raw(self, fs: int, fe: int) -> str:
        s, e = self.span(fs, fe)
        return re.sub(r"\s+", " ", self.text[s:e]).strip()

    def sentence(self, pos: int) -> tuple[int, int]:
        """Folded bounds of the sentence / line containing `pos`."""
        starts = [self.f.rfind(c, 0, pos) for c in (".", "\n", "؟", "!")]
        s = max(starts) + 1
        ends = [e for e in (self.f.find(c, pos) for c in (".", "\n", "؟", "!")) if e != -1]
        return s, (min(ends) if ends else len(self.f))


# ------------------------------------------------------------------ dates
GREG_MONTHS = {
    "يناير": 1, "فبراير": 2, "مارس": 3, "ابريل": 4, "مايو": 5, "يونيو": 6, "يونيه": 6,
    "يوليو": 7, "يوليه": 7, "اغسطس": 8, "سبتمبر": 9, "اكتوبر": 10, "نوفمبر": 11, "ديسمبر": 12,
}  # fmt: skip
HIJRI_MONTHS = {
    "محرم": 1, "صفر": 2, "ربيع الاول": 3, "ربيع الثاني": 4, "ربيع الاخر": 4,
    "جمادي الاولي": 5, "جمادي الاخره": 6, "جمادي الاخر": 6, "رجب": 7, "شعبان": 8, "رمضان": 9,
    "شوال": 10, "ذي القعده": 11, "ذي الحجه": 12,
}  # fmt: skip
_MONTH_ALT = "|".join(
    sorted(list(GREG_MONTHS) + list(HIJRI_MONTHS), key=len, reverse=True)
).replace(" ", r"\s+")

NUM_DATE = re.compile(
    r"(?<![\d/.\-])(\d{1,4})[ \t]*([/\-.])[ \t]*(\d{1,2})[ \t]*\2[ \t]*(\d{1,4})(?!\d)(?![/\-.]\d)"
)
NAME_DATE = re.compile(
    rf"(?<![\d/.\-])(\d{{1,2}})\s+(?:من\s+)?(?:شهر\s+)?({_MONTH_ALT})(?![ء-ي])"
    r"\s*(?:[،,]\s*)?(?:(?:سنه|عام|لسنه|لعام)\s*)?(\d{4})(?!\d)"
)
CAL_AFTER = re.compile(
    r"[ \t]*(?:\(\s*)?(هـ|ه|هجريه|هجري|الهجري|للهجره|م|ميلاديه|ميلادي|الميلادي|للميلاد)(?![ء-ي])"
)
HIJRI_SUFFIX = {"ه", "هـ", "هجريه", "هجري", "الهجري", "للهجره"}


def is_hijri_year(y: int) -> bool:
    return 1300 <= y <= 1500


@dataclass
class DateRef:
    fs: int  # folded start/end
    fe: int
    day: int
    month: int
    year: int
    order: str  # dmy | ymd | name
    suffix: str | None  # 'h' | 'g' | None  (explicit calendar marker)
    month_hijri: bool = False  # month written with a Hijri month name

    @property
    def hijri(self) -> bool:
        return (
            self.suffix == "h"
            or self.month_hijri
            or (self.suffix is None and is_hijri_year(self.year))
        )

    def problem(self) -> str | None:
        """Why the date cannot exist (Arabic fragment), or None when it can."""
        d, m, y = self.day, self.month, self.year
        if m < 1 or m > 12:
            swapped = " (ربما اليوم والشهر مقلوبان)" if 1 <= d <= 12 and self.order == "dmy" else ""
            return f"الشهر {m} غير موجود{swapped}"
        if d < 1:
            return "اليوم صفر غير ممكن"
        if self.hijri:
            return f"الشهر الهجري لا يزيد على 30 يوماً (اليوم {d})" if d > 30 else None
        if y < 1:
            return "السنة غير صالحة"
        last = calendar.monthrange(y, m)[1] if 1 <= y <= 9999 else 31
        if d > last:
            return f"الشهر {m} في سنة {y} فيه {last} يوماً فقط (اليوم {d})"
        return None

    def as_iso(self) -> str | None:
        if self.hijri or self.problem():
            return None
        return f"{self.year:04d}-{self.month:02d}-{self.day:02d}"


def _suffix(f: str, end: int) -> str | None:
    m = CAL_AFTER.match(f, end)
    if not m:
        return None
    return "h" if m.group(1) in HIJRI_SUFFIX else "g"


def find_dates(F: Folded) -> list[DateRef]:
    """Numeric (d/m/yyyy, yyyy/m/d) and month-name dates that carry a 4-digit year."""
    out: list[DateRef] = []
    f = F.f
    for m in NUM_DATE.finditer(f):
        a, b, c = m.group(1), m.group(3), m.group(4)
        if len(a) == 4 and len(c) == 4:
            continue
        if len(c) == 4:
            d, mo, y, order = int(a), int(b), int(c), "dmy"
        elif len(a) == 4:
            y, mo, d, order = int(a), int(b), int(c), "ymd"
        else:
            continue
        out.append(DateRef(m.start(), m.end(), d, mo, y, order, _suffix(f, m.end())))
    for m in NAME_DATE.finditer(f):
        name = re.sub(r"\s+", " ", m.group(2))
        hij = name in HIJRI_MONTHS
        mo = HIJRI_MONTHS[name] if hij else GREG_MONTHS[name]
        out.append(
            DateRef(m.start(), m.end(), int(m.group(1)), mo, int(m.group(3)), "name",
                    _suffix(f, m.end()), hij)
        )  # fmt: skip
    out.sort(key=lambda d: d.fs)
    return out


# ------------------------------------------------------------------ words
_TOK = re.compile(r"[ \t]*\(?[ \t]*([ء-ي]+|\d+)[ \t]*\)?")


def read_words(
    f: str, pos: int, max_words: int, stop: set[str], terminal: set[str] | None = None
) -> tuple[list[str], int]:
    """Read up to `max_words` word tokens from `pos`, stopping at a stop word."""
    words: list[str] = []
    end = pos
    for _ in range(max_words):
        m = _TOK.match(f, end)
        if not m:
            break
        w = m.group(1)
        if w in stop:
            break
        words.append(w)
        end = m.end()
        if terminal and w in terminal:
            break
    return words, end


def to_int(s: str) -> int:
    return int(s.translate(_FOLD))
