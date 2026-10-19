# Optional downloads: third-party notes

Nothing here is bundled or redistributed by Mizaj Studio. These files are downloaded only when the
user turns on "online resources", ticks the licence box and presses download; each is pinned by URL,
size and sha256 in `catalog.json` and verified before it is installed.

## Piper TTS (natural Arabic read-aloud)

| Part | Source | Licence | sha256 |
| :-- | :-- | :-- | :-- |
| Engine `piper_windows_amd64.zip` (release 2023.11.14-2, 22,477,236 bytes) | github.com/rhasspy/piper | MIT (LICENSE.md). The archive also contains espeak-ng (GPL-3.0) and onnxruntime (MIT) | `f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea` |
| Voice `ar_JO-kareem-medium.onnx` (63,201,294 bytes) | huggingface.co/rhasspy/piper-voices | **Unspecified** (see below) | `9e95cab07b679da603bba17c4dec7ab3111320571964ee95c0379603c086491e` |
| Voice config `ar_JO-kareem-medium.onnx.json` (5,024 bytes) | same | same | `ea6d9b9d9076dbdb6bf5c98c6a141ef154959d2359709b37855727964e7d6c4d` |

**Voice licence is unspecified.** The model card names the training dataset
https://github.com/AliMokhammad/arabicttstrain/ with "License: See URL", and that repository has no
licence file. The voice is therefore never bundled, never mirrored and never redistributed by this
project: it is a user-initiated download from Hugging Face, the download dialog shows
«ترخيص بيانات تدريب هذا الصوت غير محدد من مصدره؛ يُنزَّل للاستخدام الشخصي على جهازك فقط», and the
user must tick the licence checkbox first. Revisit if the dataset author publishes a licence.

The `ar_JO-kareem-low` variant (16 kHz) has the same ~63 MB size, so it is not offered.

`piper.exe` is not code-signed: see `desktop/WINDOWS_DEFENDER.md`.
