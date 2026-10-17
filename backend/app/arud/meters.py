"""The 16 classical meters (buhur) as generators of allowed hemistich patterns.

Each foot (taf'ila) is a binary string (1 = moving, 0 = sakin). Allowed variations are produced by
the usual zihaf (applied to any foot) and 'ilal (applied to the last foot of a hemistich) as
pattern transformations. This is deliberately permissive for ordinary verse and only covers
single and double variations per foot; rare combinations (e.g. batr, tashi'th, majzu' special
cases) are not modelled. See `LIMITS`.
"""

from __future__ import annotations

from functools import cache
from itertools import product

FOOT = {
    "فعولن": "11010",
    "مفاعيلن": "1101010",
    "فاعلن": "10110",
    "مستفعلن": "1010110",
    "متفاعلن": "1110110",
    "مفاعلتن": "1101110",
    "فاعلاتن": "1011010",
    "مفعولات": "1010101",
}
LIMITS = (
    "Hemistich-level detection from fully diacritized text. Common zihaf/'ilal and at most two "
    "variations per foot are modelled; ishba' is accepted at the end of a hemistich; poems that "
    "mix meters, muwashshahat and free verse are not recognised."
)


def _drop(p: str, i: int, want: str) -> str | None:
    return p[:i] + p[i + 1 :] if len(p) > i and p[i] == want else None


# zihaf (any foot)
def khabn(p):  # drop the 2nd letter when sakin
    return _drop(p, 1, "0")


def tayy(p):  # drop the 4th letter when sakin
    return _drop(p, 3, "0")


def qabd(p):  # drop the 5th letter when sakin
    return _drop(p, 4, "0")


def kaff(p):  # drop the 7th letter when sakin
    return _drop(p, 6, "0")


def idmar(p):  # make the 2nd letter sakin
    return p[:1] + "0" + p[2:] if len(p) > 1 and p[1] == "1" else None


def waqs(p):  # drop the 2nd letter when moving
    return _drop(p, 1, "1")


def asb(p):  # make the 5th letter sakin
    return p[:4] + "0" + p[5:] if len(p) > 4 and p[4] == "1" else None


def aql(p):  # drop the 5th letter when moving
    return _drop(p, 4, "1")


ZIHAF = {"khabn": khabn, "tayy": tayy, "qabd": qabd, "kaff": kaff, "idmar": idmar, "waqs": waqs,
         "asb": asb, "aql": aql}  # fmt: skip


# 'ilal (last foot only)
def hadhf(p):  # drop a final light sabab
    return p[:-2] if p.endswith("10") and len(p) > 3 else None


def qat(p):  # drop the final sakin and make the letter before it sakin
    return p[:-2] + "0" if p.endswith("10") and p.endswith("110") else None


def qasr(p):  # drop the final sakin of a light sabab, make the letter before it sakin
    return p[:-2] + "0" if p.endswith("010") and not p.endswith("110") else None


def tarfil(p):  # add a light sabab after a final watad
    return p + "10" if p.endswith("110") else None


def tadhyil(p):  # add a sakin
    return p + "0" if p.endswith("110") else None


def tasbigh(p):  # add a sakin after a final light sabab
    return p + "0" if p.endswith("10") and not p.endswith("110") else None


ILAL = {"hadhf": hadhf, "qat": qat, "qasr": qasr, "tarfil": tarfil, "tadhyil": tadhyil,
        "tasbigh": tasbigh}  # fmt: skip

# name -> feet of ONE hemistich
METERS: dict[str, list[str]] = {
    "الطويل": ["فعولن", "مفاعيلن", "فعولن", "مفاعيلن"],
    "المديد": ["فاعلاتن", "فاعلن", "فاعلاتن"],
    "البسيط": ["مستفعلن", "فاعلن", "مستفعلن", "فاعلن"],
    "الوافر": ["مفاعلتن", "مفاعلتن", "فعولن"],
    "الكامل": ["متفاعلن", "متفاعلن", "متفاعلن"],
    "الهزج": ["مفاعيلن", "مفاعيلن"],
    "الرجز": ["مستفعلن", "مستفعلن", "مستفعلن"],
    "الرمل": ["فاعلاتن", "فاعلاتن", "فاعلاتن"],
    "السريع": ["مستفعلن", "مستفعلن", "فاعلن"],
    "المنسرح": ["مستفعلن", "مفعولات", "مستفعلن"],
    "الخفيف": ["فاعلاتن", "مستفعلن", "فاعلاتن"],
    "المضارع": ["مفاعيلن", "فاعلاتن"],
    "المقتضب": ["مفعولات", "مستفعلن"],
    "المجتث": ["مستفعلن", "فاعلاتن"],
    "المتقارب": ["فعولن", "فعولن", "فعولن", "فعولن"],
    "المتدارك": ["فاعلن", "فاعلن", "فاعلن", "فاعلن"],
}


def _closure(base: str, ops: dict, depth: int = 2) -> dict[str, int]:
    """pattern -> minimal number of operations needed to derive it from `base`."""
    seen = {base: 0}
    frontier = {base}
    for d in range(1, depth + 1):
        nxt = set()
        for p in frontier:
            for fn in ops.values():
                v = fn(p)
                if v and v not in seen:
                    seen[v] = d
                    nxt.add(v)
        frontier = nxt
    return seen


@cache
def foot_variants(foot: str, last: bool) -> dict[str, int]:
    out = _closure(FOOT[foot], ZIHAF, 2)
    if last:
        for p, c in list(out.items()):
            for fn in ILAL.values():
                v = fn(p)
                if v and out.get(v, 99) > c + 1:
                    out[v] = c + 1
    return {v: c for v, c in out.items() if len(v) >= 3}


@cache
def hemistich_patterns(meter: str) -> dict[str, int]:
    """every allowed hemistich pattern -> its total number of variations (a simplicity cost)."""
    feet = METERS[meter]
    sets = [foot_variants(f, i == len(feet) - 1) for i, f in enumerate(feet)]
    out: dict[str, int] = {}
    for combo in product(*[list(s.items()) for s in sets]):
        pat = "".join(p for p, _ in combo)
        cost = sum(c for _, c in combo)
        if out.get(pat, 99) > cost:
            out[pat] = cost
    return out


@cache
def _prefixes(meter: str) -> frozenset[str]:
    return frozenset(p[:k] for p in hemistich_patterns(meter) for k in range(1, len(p) + 1))


def match(pattern: str) -> list[tuple[str, int]]:
    """(meter, cost) pairs whose hemistich can be exactly `pattern`, cheapest first. A trailing
    moving letter may be a lengthened vowel (ishba'), which is tried as pattern + '0'."""
    cands = [pattern] + ([pattern + "0"] if pattern.endswith("1") else [])
    found: list[tuple[str, int]] = []
    for m in METERS:
        pats = hemistich_patterns(m)
        costs = [pats[c] for c in cands if c in pats]
        if costs:
            found.append((m, min(costs)))
    return sorted(found, key=lambda t: t[1])


def best_partial(pattern: str) -> tuple[str, int]:
    """(meter, longest matching prefix length): where the verse starts to break the meter."""
    best = ("", 0)
    for m in METERS:
        pre = _prefixes(m)
        k = 0
        while k < len(pattern) and pattern[: k + 1] in pre:
            k += 1
        if k > best[1]:
            best = (m, k)
    return best
