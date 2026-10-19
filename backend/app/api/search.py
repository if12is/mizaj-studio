"""Full-text search across all documents («بحث في كل الملفات», palette group «في المحتوى»)."""

from __future__ import annotations

import sqlite3
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query

from app.api.deps import get_db
from app.core import search as fts

router = APIRouter(prefix="/api/search", tags=["search"])
Db = Annotated[sqlite3.Connection, Depends(get_db)]


@router.get("")
def search_documents(
    db: Db,
    q: Annotated[str, Query(max_length=200)],
    limit: Annotated[int, Query(ge=1, le=100)] = 30,
    snippets: Annotated[int, Query(ge=1, le=10)] = 3,
    project_id: int | None = None,
) -> dict[str, Any]:
    """Documents whose title or text contains every word of `q` (prefix match), ignoring
    diacritics, tatweel and hamza / ya / ta-marbuta variants. Best matches first; each result
    carries highlighted excerpts (`ranges` are [start, end) offsets inside the excerpt `text`)
    and, per excerpt, the `offset` of the match in the document as the editor counts it."""
    toks = fts.tokens(q)
    if not toks or sum(len(t) for t in toks) < 2:
        return {"query": q, "results": [], "total": 0}
    sql = (
        "SELECT d.id, d.project_id, d.title, d.raw_content, d.updated_at, p.name AS project_name "
        "FROM document_search s JOIN documents d ON d.id=s.rowid "
        "JOIN projects p ON p.id=d.project_id "
        "WHERE document_search MATCH ? AND d.is_deleted=0"
    )
    args: list[Any] = [fts.fts_query(toks)]
    if project_id is not None:
        sql += " AND d.project_id=?"
        args.append(project_id)
    sql += " ORDER BY bm25(document_search, 4.0, 1.0), d.updated_at DESC LIMIT ?"
    args.append(limit)
    try:
        rows = db.execute(sql, args).fetchall()
    except sqlite3.OperationalError:  # malformed FTS expression: treat as no match
        return {"query": q, "results": [], "total": 0}
    results = []
    for r in rows:
        found, count = fts.make_snippets(r["raw_content"], toks, snippets)
        title_hits = fts.find_hits(fts.normalize(r["title"]), toks)
        tpos = fts.positions(r["title"])
        results.append(
            {
                "document_id": r["id"],
                "project_id": r["project_id"],
                "project_name": r["project_name"],
                "title": r["title"],
                "title_ranges": [
                    [tpos[a], fts.orig_end(r["title"], tpos, b)] for a, b, _ in title_hits
                ],
                "updated_at": r["updated_at"],
                "match_count": count,
                "snippets": [s.as_dict() for s in found],
            }
        )
    return {"query": q, "results": results, "total": len(results)}
