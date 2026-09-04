"""Group N: PHPSPEC §8.5 terminal-state rule doc conformance (ADR-033).

Phase 2 (RED) — asserts the §8.5 wording that documents the terminal-state
rule; expected to FAIL until §8.5 is updated in Phase 3.
"""

import re
from pathlib import Path

PHPSPEC = Path(__file__).resolve().parent.parent / "docs" / "spec" / "PHPSPEC.md"


def _read_spec():
    return PHPSPEC.read_text(encoding="utf-8")


def _section(start_header):
    """Return the text of a `### N.N ...` section up to the next `###`."""
    text = _read_spec()
    idx = text.find(start_header)
    assert idx != -1, f"{start_header} not found in PHPSPEC.md"
    body_start = idx + len(start_header)
    m = re.search(r"\n### ", text[body_start:])
    end = body_start + m.start() if m else len(text)
    return text[idx:end]


def test_n1_85_documents_terminal_state_rule():
    sect = _section("### 8.5 Merge Strategy")
    assert "terminal-state rule" in sect
    assert "ended" in sect
    assert "permanent" in sect
    assert "regardless of `updated_at`" in sect


def test_n2_85_preserves_lww_and_local_wins_tie():
    sect = _section("### 8.5 Merge Strategy")
    assert "updated_at" in sect
    assert "newer wins" in sect
    assert "local wins" in sect


def test_n3_85_committed_irreversibility_preserved():
    sect = _section("### 8.5 Merge Strategy")
    assert "irreversible" in sect


def test_n4_81_activity_status_enum_unchanged():
    sect = _section("### 8.1 Row Schema")
    assert '"active"' in sect
    assert '"paused"' in sect
    assert '"ended"' in sect
