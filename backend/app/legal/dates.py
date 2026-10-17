"""Hijri / Gregorian dates in words (Task 7.10.3). Hijri conversion: `hijridate` (MIT, Umm
al-Qura calendar, 1343-1500 AH only)."""

from __future__ import annotations

import datetime as dt
from typing import Any

from hijridate import Gregorian, Hijri

from app.legal.numbering import ordinal
from app.legal.tafqeet import GEN, TafqeetError, canon, norm_case, number_words

DAYS = {  # datetime.weekday(): Monday=0
    0: "الِاثْنَيْنِ", 1: "الثُّلَاثَاءِ", 2: "الْأَرْبِعَاءِ", 3: "الْخَمِيسِ", 4: "الْجُمُعَةِ",
    5: "السَّبْتِ", 6: "الْأَحَدِ",
}  # fmt: skip
DAYS_PLAIN = {0: "الاثنين", 1: "الثلاثاء", 2: "الأربعاء", 3: "الخميس", 4: "الجمعة", 5: "السبت",
              6: "الأحد"}  # fmt: skip

DAYS_EN = {0: "Monday", 1: "Tuesday", 2: "Wednesday", 3: "Thursday", 4: "Friday",
           5: "Saturday", 6: "Sunday"}  # fmt: skip

HIJRI_MONTHS = [  # genitive, after "شَهْرِ"
    "مُحَرَّمٍ", "صَفَرٍ", "رَبِيعٍ الْأَوَّلِ", "رَبِيعٍ الْآخِرِ", "جُمَادَى الْأُولَى",
    "جُمَادَى الْآخِرَةِ", "رَجَبٍ", "شَعْبَانَ", "رَمَضَانَ", "شَوَّالٍ", "ذِي الْقَعْدَةِ",
    "ذِي الْحِجَّةِ",
]  # fmt: skip
GREGORIAN_MONTHS = {
    "gulf": ["يَنَايِرَ", "فِبْرَايِرَ", "مَارِسَ", "أَبْرِيلَ", "مَايُو", "يُونِيُو", "يُولِيُو",
             "أَغُسْطُسَ", "سِبْتَمْبَرَ", "أُكْتُوبَرَ", "نُوفَمْبَرَ", "دِيسَمْبَرَ"],
    "levant": ["كَانُونَ الثَّانِي", "شُبَاطَ", "آذَارَ", "نِيسَانَ", "أَيَّارَ", "حَزِيرَانَ",
               "تَمُّوزَ", "آبَ", "أَيْلُولَ", "تِشْرِينَ الْأَوَّلِ", "تِشْرِينَ الثَّانِي",
               "كَانُونَ الْأَوَّلِ"],
}  # fmt: skip
HIJRI_RANGE = (1343, 1500)


def _to_gregorian(y: int, m: int, d: int, calendar: str, adjust: int) -> tuple[dt.date, Hijri]:
    try:
        if calendar == "hijri":
            h = Hijri(y, m, d)
            g = h.to_gregorian()
            greg = dt.date(g.year, g.month, g.day) + dt.timedelta(days=adjust)
            return greg, h
        greg = dt.date(y, m, d)
    except (ValueError, OverflowError) as exc:
        raise TafqeetError(f"invalid date: {exc}") from exc
    shifted = greg - dt.timedelta(days=adjust)
    try:
        return greg, Gregorian(shifted.year, shifted.month, shifted.day).to_hijri()
    except (ValueError, OverflowError) as exc:
        lo, hi = HIJRI_RANGE
        raise TafqeetError(f"date outside the supported Umm al-Qura range ({lo}-{hi} AH)") from exc


def _year_words(y: int, spelling: str) -> str:
    # سنة is feminine; the year is its mudaf ilayh (genitive)
    return number_words(y, "f", GEN, spelling=spelling)


def date_words(
    year: int,
    month: int,
    day: int,
    calendar: str = "gregorian",
    *,
    hijri_adjust: int = 0,
    gregorian_names: str = "gulf",
    spelling: str = "ma'a",
    case: str | None = None,
    with_day_name: bool = True,
    claimed_day_name: str | None = None,
) -> dict[str, Any]:
    """Words for a date in both calendars. `hijri_adjust` (-1/0/+1) shifts the Hijri date
    relative to Umm al-Qura (moon-sighting differences). Dates outside 1343-1500 AH fail."""
    if calendar not in ("gregorian", "hijri"):
        raise TafqeetError("calendar must be 'gregorian' or 'hijri'")
    if hijri_adjust not in (-1, 0, 1):
        raise TafqeetError("hijri_adjust must be -1, 0 or 1")
    if gregorian_names not in GREGORIAN_MONTHS:
        raise TafqeetError("gregorian_names must be 'gulf' or 'levant'")
    c = norm_case(case)
    greg, hij = _to_gregorian(year, month, day, calendar, hijri_adjust)
    hij_date = (hij.year, hij.month, hij.day)
    # hijri_adjust shifts the displayed Hijri day for a Gregorian input
    if calendar == "gregorian" and hijri_adjust:
        shifted = greg - dt.timedelta(days=hijri_adjust)
        h2 = Gregorian(shifted.year, shifted.month, shifted.day).to_hijri()
        hij_date = (h2.year, h2.month, h2.day)
    hy, hm, hd = hij_date
    hijri_text = (
        f"{ordinal(hd, False, c)} مِنْ شَهْرِ {HIJRI_MONTHS[hm - 1]} لِسَنَةِ "
        f"{_year_words(hy, spelling)} هِجْرِيَّةٍ"
    )
    gname = GREGORIAN_MONTHS[gregorian_names][greg.month - 1]
    greg_text = (
        f"{ordinal(greg.day, False, c)} مِنْ شَهْرِ {gname} لِسَنَةِ "
        f"{_year_words(greg.year, spelling)} مِيلَادِيَّةٍ"
    )
    day_name = DAYS[greg.weekday()]  # always genitive: it is the mudaf ilayh of "يوم"
    first, second = (hijri_text, greg_text) if calendar == "hijri" else (greg_text, hijri_text)
    v = {"nominative": "\u064f", "accusative": "\u064e", "genitive": "\u0650"}[c]
    prefix = f"يَوْم{v} {day_name} " if with_day_name else ""
    full = f"{prefix}الْمُوَافِق{v} {first}، الْمُوَافِق{v} {second}"
    warnings: list[dict[str, str]] = []
    if claimed_day_name:
        from app.engine.normalize import strip_marks

        def n(s: str) -> str:
            s = (
                strip_marks(s).replace("ال", "", 1)
                if strip_marks(s).startswith("ال")
                else strip_marks(s)
            )
            return s.replace("إ", "ا").replace("أ", "ا").replace("آ", "ا").replace("ة", "ه")

        claimed = n(claimed_day_name.replace("يوم", "").strip())
        if claimed != n(DAYS_PLAIN[greg.weekday()]):
            warnings.append({
                "type": "day_name_mismatch",
                "message_ar": f"اليوم المذكور لا يطابق التاريخ؛ التاريخ يوافق يوم {DAYS_PLAIN[greg.weekday()]}.",
                "message_en": f"The day name does not match the date; it is a {DAYS_EN[greg.weekday()]}.",
            })  # fmt: skip
    return {
        "words": canon(full),
        "hijri_words": canon(hijri_text),
        "gregorian_words": canon(greg_text),
        "day_name": canon(DAYS[greg.weekday()]),
        "hijri": {"year": hy, "month": hm, "day": hd},
        "gregorian": {"year": greg.year, "month": greg.month, "day": greg.day},
        "basis": "Umm al-Qura" + (f" {hijri_adjust:+d} day" if hijri_adjust else ""),
        "warnings": warnings,
    }
