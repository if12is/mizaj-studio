"""7.4.1 Quran protection: detect Quranic verses in a document so they are never altered.

The verse text is NOT shipped in the installer. It is Tanzil text (CC BY 3.0, verbatim only),
installed into <data-dir>/resources/quran/ by import or opt-in download (see `store`).
"""

from .detect import find_protected_spans, get_index, is_quran_text, reset_index

__all__ = ["find_protected_spans", "get_index", "is_quran_text", "reset_index"]
