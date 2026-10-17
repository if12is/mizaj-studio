"""Ollama second opinion (7.8.2) and LanguageTool (7.9.4); loopback only, opt-in."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.core.errors import MizajError, validation_error
from app.engine.normalize import has_arabic_letters, strip_marks
from app.resources import net
from app.tools import discovery

MAX_CHARS = 20_000


def _unavailable(tool: str, url: str) -> MizajError:
    return MizajError(
        "ERR_TOOL_UNAVAILABLE",
        503,
        f"الأداة المحلية ({tool}) غير متاحة. تأكد من تشغيلها.",
        f"Local tool '{tool}' was not detected at {url}.",
        {"tool": tool, "url": url},
    )


def ollama_suggest(db_path: Path, text: str, model: str, timeout: float = 120.0) -> dict[str, Any]:
    net.require_switch(db_path, "online_ollama")
    if not text.strip() or len(text) > MAX_CHARS or not model.strip():
        raise validation_error("text (<= 20000 chars) and model are required")
    url = discovery.ollama_url()
    prompt = (
        "أضف التشكيل الكامل إلى النص العربي التالي دون تغيير أي حرف أو إضافة أي شرح. "
        "أعد النص المشكول فقط.\n\n" + text
    )
    try:
        data = net.local_request(
            url,
            "/api/generate",
            {"model": model, "prompt": prompt, "stream": False, "options": {"temperature": 0}},
            timeout=timeout,
        )
    except MizajError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _unavailable("ollama", url) from exc
    out = str(data.get("response", "")).strip()
    base = {"model": model, "source": "ollama"}
    if not out:
        return {**base, "accepted": False, "text": None, "reason": "empty_response"}
    if strip_marks(out) != strip_marks(text.strip()):
        return {**base, "accepted": False, "text": None, "reason": "base_letters_changed"}
    lead = text[: len(text) - len(text.lstrip())]
    trail = text[len(text.rstrip()) :]
    return {**base, "accepted": True, "text": lead + out + trail, "reason": None}


def _cp_index(text: str, off16: int) -> int:
    n = 0
    for i, ch in enumerate(text):
        if n >= off16:
            return i
        n += 2 if ord(ch) > 0xFFFF else 1
    return len(text)


def languagetool_check(db_path: Path, text: str, language: str = "ar") -> dict[str, Any]:
    net.require_switch(db_path, "online_languagetool")
    if len(text) > 200_000:
        raise validation_error("text too long")
    url = discovery.languagetool_url()
    try:
        data = net.local_request(
            url, "/v2/check", form={"language": language, "text": text}, timeout=60.0
        )
    except MizajError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise _unavailable("languagetool", url) from exc
    issues = []
    for m in data.get("matches", []):
        try:
            s16, ln16 = int(m["offset"]), int(m["length"])
        except (KeyError, TypeError, ValueError):
            continue
        start = _cp_index(text, s16)
        end = _cp_index(text, s16 + ln16)
        rule = m.get("rule") or {}
        itype = str(rule.get("issueType", ""))
        issues.append(
            {
                "start": start,
                "end": end,
                "start16": s16,
                "end16": s16 + ln16,
                "word": text[start:end],
                "code": f"LT_{rule.get('id', 'RULE')}",
                "category": "grammar",
                "severity": "info" if itype in ("style", "typographical") else "warning",
                "message_ar": m.get("message") or m.get("shortMessage") or "",
                "suggestions": [
                    r["value"] for r in (m.get("replacements") or [])[:5] if "value" in r
                ],
                "confidence": 0.5,
                "source": "languagetool",
                "rule_category": (rule.get("category") or {}).get("id", ""),
            }
        )
    return {
        "issues": issues,
        "has_arabic_rules": has_arabic_letters(text),
        "source": "languagetool",
    }
