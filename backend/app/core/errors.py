"""Unified error envelope (docs/architecture/error-codes.md)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

log = logging.getLogger("mizaj.errors")


class MizajError(Exception):
    def __init__(
        self,
        error_code: str,
        status: int,
        message_ar: str,
        message_en: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message_en)
        self.error_code = error_code
        self.status = status
        self.message_ar = message_ar
        self.message_en = message_en
        self.details = details or {}

    def envelope(self) -> dict[str, Any]:
        return {
            "error_code": self.error_code,
            "message_ar": self.message_ar,
            "message_en": self.message_en,
            "details": self.details,
        }


def not_found(what: str, ident: Any) -> MizajError:
    return MizajError(
        "ERR_NOT_FOUND", 404, "العنصر المطلوب غير موجود.", f"{what} not found.", {"id": ident}
    )


def validation_error(message_en: str, details: dict[str, Any] | None = None) -> MizajError:
    return MizajError("ERR_VALIDATION", 422, "بيانات غير صالحة.", message_en, details)


def duplicate_word(word: str) -> MizajError:
    return MizajError(
        "ERR_DUPLICATE_WORD",
        409,
        "الكلمة موجودة مسبقاً في القاموس.",
        "Word already exists in the dictionary.",
        {"word_or_phrase": word},
    )


def engine_not_ready(mode: str) -> MizajError:
    return MizajError(
        "ERR_ENGINE_NOT_READY",
        503,
        "المحرك لا يزال قيد التحميل، حاول مجدداً بعد لحظات.",
        "The engine is still loading.",
        {"mode": mode},
    )


def model_missing(path: str) -> MizajError:
    return MizajError(
        "ERR_MODEL_MISSING",
        500,
        "ملف النموذج غير موجود. شغّل إصلاح النماذج أو استخدم الوضع السريع.",
        "The CATT model file is missing.",
        {"path": path},
    )


def task_cancelled() -> MizajError:
    return MizajError(
        "ERR_TASK_CANCELLED", 499, "تم إلغاء المهمة.", "The task was cancelled by the client."
    )


def docx_corrupt(detail: str = "") -> MizajError:
    return MizajError(
        "ERR_DOCX_CORRUPT",
        422,
        "ملف الوورد تالف أو غير صالح.",
        "The .docx file is not a valid Word document.",
        {"reason": detail},
    )


def docx_write_locked(path: str) -> MizajError:
    return MizajError(
        "ERR_DOCX_WRITE_LOCKED",
        423,
        "تعذر حفظ ملف الوورد لأن الملف مفتوح حالياً في برنامج آخر.",
        "Cannot write DOCX file because it is locked by another process.",
        {"path": path},
    )


def disk_full(path: str) -> MizajError:
    return MizajError(
        "ERR_DISK_FULL",
        507,
        "لا توجد مساحة كافية على القرص.",
        "No space left on device.",
        {"path": path},
    )


def _json(err: MizajError) -> JSONResponse:
    return JSONResponse(status_code=err.status, content=err.envelope())


def install_handlers(app: FastAPI) -> None:
    @app.exception_handler(MizajError)
    async def _mizaj(_: Request, exc: MizajError) -> JSONResponse:
        return _json(exc)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"loc": [str(p) for p in e.get("loc", ())], "msg": e.get("msg", ""), "type": e["type"]}
            for e in exc.errors()
        ]
        return _json(validation_error("Request validation failed.", {"errors": errors}))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        if exc.status_code == 404:
            return _json(not_found("Resource", None))
        return _json(MizajError("ERR_HTTP", exc.status_code, "حدث خطأ.", str(exc.detail), {}))

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        log.exception("Unhandled error")
        return _json(
            MizajError("ERR_INTERNAL", 500, "حدث خطأ داخلي.", "Internal server error.", {})
        )
