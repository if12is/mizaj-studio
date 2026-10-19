"""Natural Arabic read-aloud with Piper (MIT) running locally as a child process.

* The engine and the voice are optional catalog resources (`piper-engine-win`,
  `piper-voice-ar-jo-kareem-medium`) installed under `<data-dir>/resources/`.
* The text goes to piper's STDIN only (never argv, never a log line, never a URL). The WAV is
  written to a private (0700) temp folder that is removed before this module returns.
* Every failure is mapped to an Arabic error envelope so the UI can fall back to the system voice.
* Test hook (unpackaged builds only, see desktop/src/main/index.ts): `MIZAJ_E2E_FAKE_PIPER` names
  an executable that is run instead of piper.exe; it is honoured only together with
  `MIZAJ_ALLOW_TEST_HOOKS=1`, which the Electron main process sets only when `!app.isPackaged`.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from app.core.errors import MizajError

log = logging.getLogger("mizaj.tts")

ENGINE_ID = "piper-engine-win"
VOICE_ID = "piper-voice-ar-jo-kareem-medium"
VOICE_FILE = "ar_JO-kareem-medium.onnx"
MAX_CHARS = 2000
LENGTH_SCALE_MIN, LENGTH_SCALE_MAX = 0.5, 2.0
TIMEOUT_S = 60.0
MAX_WAV_BYTES = 64 * 1024 * 1024
CREATE_NO_WINDOW = 0x08000000  # never flash a console window (Windows)
WINERROR_VIRUS = 225  # ERROR_VIRUS_INFECTED: Defender blocked the executable
WINERROR_VIRUS_UNWANTED = 226

Runner = Callable[..., Any]


def fake_hook() -> str | None:
    if os.environ.get("MIZAJ_ALLOW_TEST_HOOKS") == "1":
        return os.environ.get("MIZAJ_E2E_FAKE_PIPER") or None
    return None


def _res(data_dir: Path, rid: str) -> Path:
    return Path(data_dir) / "resources" / rid


def locate(data_dir: Path) -> dict[str, Path] | None:
    """Paths of an installed engine + voice, or None."""
    fake = fake_hook()
    if fake:
        return {"exe": Path(fake), "model": Path(fake), "config": Path(fake)}
    exe = _res(data_dir, ENGINE_ID) / "piper" / "piper.exe"
    model = _res(data_dir, VOICE_ID) / VOICE_FILE
    config = model.with_name(VOICE_FILE + ".json")
    if exe.is_file() and model.is_file() and config.is_file():
        return {"exe": exe, "model": model, "config": config}
    return None


def status(data_dir: Path) -> dict[str, Any]:
    fake = fake_hook()
    engine_dir = _res(data_dir, ENGINE_ID)
    voice = _res(data_dir, VOICE_ID)
    engine_meta = (engine_dir / "installed.json").is_file()
    return {
        "available": locate(data_dir) is not None,
        "engine_installed": bool(fake) or (engine_dir / "piper" / "piper.exe").is_file(),
        "voice_installed": bool(fake) or (voice / VOICE_FILE).is_file(),
        # installed once but the executable is gone: antivirus quarantine is the usual cause
        "engine_missing_after_install": engine_meta
        and not (engine_dir / "piper" / "piper.exe").is_file(),
        "voice": "ar_JO-kareem-medium",
        "sample_rate": 22050,
    }


def _err(code: str, status_code: int, ar: str, en: str, **details: Any) -> MizajError:
    return MizajError(code, status_code, ar, en, details)


def clamp_length_scale(v: float) -> float:
    return max(LENGTH_SCALE_MIN, min(LENGTH_SCALE_MAX, float(v)))


def _is_wav(b: bytes) -> bool:
    return len(b) > 44 and b[:4] == b"RIFF" and b[8:12] == b"WAVE"


def synthesize(
    data_dir: Path,
    text: str,
    length_scale: float = 1.0,
    *,
    run: Runner | None = None,
) -> bytes:
    """Return WAV bytes for `text`. `run` is injectable so tests never start a real process."""
    text = text.strip()
    if not text:
        raise _err("ERR_VALIDATION", 422, "لا يوجد نص للقراءة.", "Empty text.")
    if len(text) > MAX_CHARS:
        raise _err(
            "ERR_PAYLOAD_TOO_LARGE", 413, "الجملة أطول من الحد المسموح للقراءة.",
            "Text too long for one synthesis call.", limit=MAX_CHARS,
        )  # fmt: skip
    found = locate(data_dir)
    if found is None:
        st = status(data_dir)
        if st["engine_missing_after_install"]:
            raise _blocked()
        raise _err(
            "ERR_PIPER_MISSING", 409,
            "صوت Piper غير مثبّت. نزّل المحرك والصوت من الإعدادات ← الاتصال والموارد المجانية.",
            "Piper engine or voice is not installed.",
        )  # fmt: skip
    exe = found["exe"]
    if not exe.is_file():
        raise _blocked()

    base = Path(data_dir) / "tts-tmp"
    base.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix="job-", dir=base))
    try:
        os.chmod(tmp, 0o700)
        out = tmp / "out.wav"
        cmd = [
            str(exe), "--model", str(found["model"]), "--config", str(found["config"]),
            "--output_file", str(out), "--length_scale", f"{clamp_length_scale(length_scale):.3f}",
        ]  # fmt: skip
        kwargs: dict[str, Any] = {
            "input": (text + "\n").encode("utf-8"),
            "stdout": subprocess.DEVNULL,
            "stderr": subprocess.DEVNULL,
            "timeout": TIMEOUT_S,
            "cwd": str(exe.parent),
            "check": False,
        }
        if os.name == "nt":
            kwargs["creationflags"] = CREATE_NO_WINDOW
        try:
            proc = (run or subprocess.run)(cmd, **kwargs)
        except subprocess.TimeoutExpired as exc:
            raise _err(
                "ERR_PIPER_TIMEOUT", 504, "استغرق توليد الصوت وقتاً أطول من المتوقع.",
                "Piper timed out.",
            ) from exc  # fmt: skip
        except FileNotFoundError as exc:
            raise _blocked() from exc
        except OSError as exc:
            if getattr(exc, "winerror", None) in (WINERROR_VIRUS, WINERROR_VIRUS_UNWANTED):
                raise _blocked() from exc
            raise _err(
                "ERR_PIPER_SPAWN_FAILED", 500,
                "تعذر تشغيل محرك Piper. قد يمنعه برنامج الحماية أو تنقصه صلاحية التنفيذ.",
                "Could not start piper.", errno=getattr(exc, "errno", None),
            ) from exc  # fmt: skip
        code = getattr(proc, "returncode", 1)
        if code != 0:
            log.warning("piper exited with code %s", code)  # never the text
            raise _err(
                "ERR_PIPER_FAILED", 500, "فشل توليد الصوت بمحرك Piper.",
                "Piper failed.", exit_code=code,
            )  # fmt: skip
        try:
            if out.stat().st_size > MAX_WAV_BYTES:
                raise _err("ERR_PIPER_FAILED", 500, "ناتج الصوت كبير جداً.", "WAV too large.")
            wav = out.read_bytes()
        except OSError as exc:
            raise _err(
                "ERR_PIPER_FAILED", 500, "لم ينتج Piper ملفاً صوتياً.", "No output file.",
            ) from exc  # fmt: skip
        if not _is_wav(wav):
            raise _err(
                "ERR_PIPER_FAILED", 500, "ناتج Piper ليس ملف WAV صالحاً.", "Invalid WAV output.",
            )  # fmt: skip
        return wav
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _blocked() -> MizajError:
    return _err(
        "ERR_PIPER_BLOCKED", 409,
        "ملف Piper غير موجود أو محجوب، وغالباً عزله Windows Defender. "
        "أعد تنزيل المحرك أو أضف مجلد مِزَاج إلى الاستثناءات (راجع دليل Windows Defender).",
        "piper.exe is missing or blocked (likely quarantined by antivirus).",
    )  # fmt: skip


def cleanup_stale(data_dir: Path) -> None:
    """Startup: remove temp folders a crash may have left behind."""
    shutil.rmtree(Path(data_dir) / "tts-tmp", ignore_errors=True)
