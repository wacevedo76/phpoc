"""Trace logging wrapper for debugging the "ph add" flow.

Logs are written to staging_log/ at the repo root, one file per invocation.

Usage:
    from cli.trace import trace, trace_enabled

    @trace
    def my_method(self, ...):
        ...
"""

import functools
import logging
import os
import sys
import time
from pathlib import Path

# ---- Resolve log directory relative to this file's location (repo root) ----
_REPO_ROOT = Path(__file__).resolve().parent.parent
_LOG_DIR = _REPO_ROOT / "staging_log"
_LOG_DIR.mkdir(parents=True, exist_ok=True)

# One log file per invocation, named by the timestamp of the first trace call
_session_started = False


def _get_log_path():
    """Return a unique log file path for this invocation."""
    ts = time.strftime("%Y%m%d_%H%M%S")
    return _LOG_DIR / f"trace_{ts}.log"


# Configure a dedicated trace logger writing to a session file
TRACE_LOGGER = logging.getLogger("phpoc.trace")
TRACE_LOGGER.setLevel(logging.DEBUG)
TRACE_LOGGER.propagate = False  # Don't double-log to root

# We attach the handler lazily on first use so the file timestamp reflects
# when the first trace actually fires, not module import time.
_TRACE_HANDLER = None


def _ensure_handler():
    global _TRACE_HANDLER, _session_started
    if _TRACE_HANDLER is not None:
        return
    log_path = _get_log_path()
    _TRACE_HANDLER = logging.FileHandler(str(log_path), mode="w", encoding="utf-8")
    _TRACE_HANDLER.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s.%(msecs)03d [TRACE] %(message)s",
            datefmt="%H:%M:%S",
        )
    )
    TRACE_LOGGER.addHandler(_TRACE_HANDLER)
    _session_started = True
    TRACE_LOGGER.debug("=== Trace session started ===  PID=%s", os.getpid())


# Toggle — set PHPOC_TRACE=1 to enable
# Disabled by default to avoid noise during normal use.
trace_enabled = os.environ.get("PHPOC_TRACE", "0") in ("1", "true", "yes")


def trace(fn):
    """Decorator that logs method entry/exit with timing and key arguments."""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        if not trace_enabled:
            return fn(*args, **kwargs)
        _ensure_handler()

        cls_name = args[0].__class__.__name__ if args else ""
        fn_name = fn.__name__
        label = f"{cls_name}.{fn_name}"

        # Summarise args (skip self)
        arg_summary = ""
        if len(args) > 1:
            parts = [repr(a)[:120] for a in args[1:4]]
            if len(args) > 4:
                parts.append(f"...+{len(args)-4}")
            arg_summary = " " + ", ".join(parts)
        if kwargs:
            kw_parts = [f"{k}={repr(v)[:80]}" for k, v in list(kwargs.items())[:3]]
            if len(kwargs) > 3:
                kw_parts.append("...")
            arg_summary += (" " if arg_summary else "") + ", ".join(kw_parts)

        TRACE_LOGGER.debug(">>> %s(%s)", label, arg_summary)
        t0 = time.monotonic()
        try:
            result = fn(*args, **kwargs)
            elapsed = (time.monotonic() - t0) * 1000
            TRACE_LOGGER.debug("<<< %s  (%.1f ms)  → %s", label, elapsed, repr(result)[:100])
            return result
        except Exception as e:
            elapsed = (time.monotonic() - t0) * 1000
            TRACE_LOGGER.debug("<<< %s  (%.1f ms)  ✗ %s: %s", label, elapsed, type(e).__name__, e)
            raise
    return wrapper
