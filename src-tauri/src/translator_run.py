"""Capsio's full-text translation: BabelDOC through pdf2zh-next.

Takes pdf2zh-next's own command-line options and reports on stdout, one JSON
object per line: {"type": "progress", "value": 0-100, "stage": ...}, then
{"type": "done", "path": <translated PDF>, "untranslated": <paragraphs left in the
original>} or {"type": "error", "message": ...}.

BabelDOC leaves a paragraph in the original when its model request fails and still
finishes the PDF, so one bad minute leaves English paragraphs in a translation that
looks done. Here requests wait out what passes (rate limits, timeouts, server errors,
dropped connections); a refusal no wait fixes (daily limit, no points, a revoked
token) stops the run at once, so the app retries the paper later instead of keeping a
half-translated one; and paragraphs that still failed are translated again in another
pass, where everything done already comes from pdf2zh-next's cache.
"""

import asyncio
import json
import logging
import os
import sys
import time
from pathlib import Path

# Passes over a paper while paragraphs keep failing.
PASSES = 3
# The run's report, shared with the process that runs BabelDOC: one line per event.
REPORT = "CAPSIO_TRANSLATION_REPORT"
# Answers no retry changes.
REFUSED_STATUS = {401, 402, 403, 404}
REFUSED_CODES = {"daily_limit", "quota_exhausted", "model_not_found", "model_not_in_plan"}


def emit(kind, **fields):
    print(json.dumps({"type": kind, **fields}, ensure_ascii=False), flush=True)


def note(kind, text=""):
    path = os.environ.get(REPORT)
    if not path:
        return
    with open(path, "a", encoding="utf-8") as report:
        report.write(f"{kind}\t{' '.join(str(text).split())}\n")


def read_report():
    """Paragraphs left in the original, and the refusal that stopped the run if any."""
    try:
        with open(os.environ[REPORT], encoding="utf-8") as report:
            lines = [line.rstrip("\n").split("\t", 1) for line in report]
    except (KeyError, OSError):
        return 0, None
    failed = sum(1 for line in lines if line[0] == "failed")
    refused = next((line[1] for line in lines if line[0] == "refused" and len(line) > 1), None)
    return failed, refused


def use_bundled_assets():
    """Fonts, the layout model and tokenizer data ship with Capsio; BabelDOC would
    otherwise look for them, and download them, in its cache under the home folder."""
    folder = os.environ.get("CAPSIO_BABELDOC_ASSETS")
    if not folder:
        return
    bundled = Path(folder)
    import babeldoc.assets.assets as assets
    import babeldoc.const as const

    original = const.get_cache_file_path

    def lookup(filename, sub_folder=None):
        if sub_folder:
            candidate = bundled / sub_folder.strip("/") / filename
            if candidate.is_file():
                return candidate
        return original(filename, sub_folder)

    assets.get_cache_file_path = lookup
    if (bundled / "tiktoken").is_dir():
        os.environ["TIKTOKEN_CACHE_DIR"] = str(bundled / "tiktoken")


def refusal(error):
    """What the model service said, when waiting would not change its answer."""
    status = getattr(error, "status_code", None)
    code = message = None
    try:
        body = error.response.json()
        code, message = body.get("code"), body.get("error")
    except Exception:
        pass
    if status in REFUSED_STATUS or code in REFUSED_CODES:
        return " ".join(str(part) for part in (status, code, message or error) if part)
    return None


def patient_model_requests():
    """pdf2zh-next retries rate limits only; anything else fails the paragraph at once."""
    try:
        import openai
        from pdf2zh_next.translator.translator_impl.openai import OpenAITranslator
    except Exception:
        return
    passing = (openai.APITimeoutError, openai.APIConnectionError, openai.InternalServerError)
    stopped = []

    def patient(call):
        def attempt(self, text, rate_limit_params=None):
            delay, tries = 1, 0
            while True:
                # Once refused, the rest of the run fails fast; the run is retried later.
                if stopped:
                    raise RuntimeError(stopped[0])
                tries += 1
                try:
                    return call(self, text, rate_limit_params)
                except Exception as error:
                    reason = refusal(error)
                    if reason:
                        if not stopped:
                            stopped.append(reason)
                            note("refused", reason)
                        raise
                    # Rate limits clear in seconds; an outage or a restarting server gets
                    # about two minutes before the paragraph is left to the next pass.
                    limited = isinstance(error, openai.RateLimitError)
                    if not (limited or isinstance(error, passing)) or tries >= (60 if limited else 8):
                        raise
                    time.sleep(min(delay, 15 if limited else 60))
                    delay *= 2

        return attempt

    for name in ("do_translate", "do_llm_translate"):
        method = getattr(OpenAITranslator, name, None)
        if method is not None:
            # Replaces pdf2zh-next's own retry instead of wrapping it.
            setattr(OpenAITranslator, name, patient(getattr(method, "__wrapped__", method)))


class LeftInOriginal(logging.Handler):
    """BabelDOC (0.6.2, pinned in scripts/babeldoc.json) logs each paragraph it had to
    leave in the original; a content filter's refusal is logged differently and not
    counted, since another pass would not change it."""

    def emit(self, record):
        if str(record.msg).startswith("Error translating paragraph. Paragraph:"):
            note("failed")


# pdf2zh-next translates in a child process, which loads this file again (without
# running the block at the end), so all of this happens on load.
use_bundled_assets()
patient_model_requests()
logging.getLogger("babeldoc.format.pdf.document_il.midend.il_translator").addHandler(
    LeftInOriginal(logging.ERROR)
)


async def translate_once(settings, source, first):
    from pdf2zh_next.high_level import do_translate_async_stream

    checked = 0.0
    async for event in do_translate_async_stream(settings, source):
        if time.monotonic() - checked > 1:
            checked = time.monotonic()
            if read_report()[1]:
                return None
        kind = event.get("type")
        if kind in ("progress_start", "progress_update", "progress_end"):
            if first:
                emit("progress", value=float(event.get("overall_progress") or 0), stage=str(event.get("stage") or ""))
        elif kind == "finish":
            result = event.get("translate_result")
            path = getattr(result, "mono_pdf_path", None) or getattr(result, "no_watermark_mono_pdf_path", None)
            if not path:
                raise RuntimeError("翻译完成，但没有生成译文 PDF。")
            return str(path)
        elif kind == "error":
            raise RuntimeError(str(event.get("error") or "翻译失败。"))
    raise RuntimeError("翻译意外结束。")


async def translate():
    from pdf2zh_next.config import ConfigManager

    settings = ConfigManager().initialize_config()
    source = next(iter(settings.basic.input_files))
    report = Path(source).with_name("capsio-report.txt")
    os.environ[REPORT] = str(report)
    for attempt in range(PASSES):
        report.unlink(missing_ok=True)
        try:
            path = await translate_once(settings, source, attempt == 0)
        except RuntimeError as error:
            path, problem = None, str(error)
        else:
            problem = None
        failed, refused = read_report()
        if refused:
            emit("error", message=refused)
            return 1
        if problem:
            emit("error", message=problem)
            return 1
        if not failed or attempt == PASSES - 1:
            emit("done", path=path, untranslated=failed)
            return 0
        # Paragraphs failed: go over the paper again; translated ones come from the cache.
        emit("progress", value=99.0, stage="Retry")
        await asyncio.sleep(20)


if __name__ == "__main__":
    try:
        code = asyncio.run(translate())
    except Exception as error:  # the message is what the paper's page shows
        emit("error", message=f"{type(error).__name__}: {error}")
        code = 1
    sys.exit(code)
