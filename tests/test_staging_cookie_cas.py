"""test_staging_cookie_cas.py — ADR-034 P1 cookie schema + Worker CAS (Phase 2 RED).

Groups:
  E-Python (E1–E6) — DeviceCookie cookie-schema migration (staging_hash + seq
    remote; last_seen_hash + last_seen_seq local) + backward-compat parse
    tolerance.
  J11 — next_seq increment base (absent→0, then +1).

RED phase (expected failures):
  E1/E2/E3 — create()/create_local() do not yet write staging_hash/seq or
    last_seen_hash/last_seen_seq, and create() has no staging_hash/seq params.
  J11 — DeviceCookie.next_seq does not exist yet.
  E4/E5/E6 — guard-green: is_valid_locally() already returns the full local
    dict (no stripping), and parse_remote() already passes JSON through
    verbatim (legacy tolerated, invalid → None).

Blueprint: docs/planning/STAGING_COOKIE_CAS_PHASE1.md
"""

import json
import time

from domain.cookie.device_cookie import DeviceCookie, COOKIE_FILE, META_FILE


def _read_json(path):
    return json.loads(path.read_text())


def _write_meta(cookie_dir, meta):
    cookie_dir.mkdir(parents=True, exist_ok=True)
    (cookie_dir / META_FILE).write_text(json.dumps(meta))


# ──────────────────────────────────────────────────────────────────────────
# Group E-Python — cookie schema + backward-compat parse tolerance
# ──────────────────────────────────────────────────────────────────────────


def test_E1_create_writes_remote_and_local_schema(cookie_dir):
    """E1: create() writes remote {device_uuid, device_specifier, staging_hash, seq}
    AND local {device_specifier, creation_time, last_seen_hash, last_seen_seq}."""
    remote = DeviceCookie.create("dev-a", cookie_dir)

    assert remote is not None
    assert set(remote.keys()) >= {"device_uuid", "device_specifier", "staging_hash", "seq"}
    assert remote["device_uuid"] == "dev-a"
    assert remote["staging_hash"] is None
    assert remote["seq"] == 0

    # Remote cookie bytes cached on disk for transport push
    remote_on_disk = _read_json(cookie_dir / COOKIE_FILE)
    assert set(remote_on_disk.keys()) >= {"device_uuid", "device_specifier", "staging_hash", "seq"}

    local = _read_json(cookie_dir / META_FILE)
    assert set(local.keys()) >= {"device_specifier", "creation_time", "last_seen_hash", "last_seen_seq"}
    assert local["last_seen_hash"] is None
    assert local["last_seen_seq"] == 0


def test_E2_create_defaults_and_explicit_values(cookie_dir):
    """E2: create() defaults staging_hash to null and seq to 0; honors explicit."""
    # Defaults (no params)
    remote = DeviceCookie.create("dev-a", cookie_dir)
    assert remote.get("staging_hash") is None
    assert remote.get("seq") == 0

    # Explicit values
    remote2 = DeviceCookie.create("dev-a", cookie_dir, staging_hash="abc123", seq=7)
    assert remote2 is not None
    assert remote2["staging_hash"] == "abc123"
    assert remote2["seq"] == 7


def test_E3_create_local_writes_baseline_fields(cookie_dir):
    """E3: create_local() writes last_seen_hash + last_seen_seq alongside the
    device_specifier + creation_time baseline."""
    ok = DeviceCookie.create_local(cookie_dir)
    assert ok is True

    local = _read_json(cookie_dir / META_FILE)
    assert set(local.keys()) >= {"device_specifier", "creation_time", "last_seen_hash", "last_seen_seq"}
    assert local["last_seen_hash"] is None
    assert local["last_seen_seq"] == 0


def test_E4_is_valid_locally_includes_baseline(cookie_dir):
    """E4: is_valid_locally() returns the dict including last_seen_hash +
    last_seen_seq (not stripped)."""
    _write_meta(cookie_dir, {
        "device_specifier": "spec-1",
        "creation_time": int(time.time() * 1000),
        "last_seen_hash": "abc",
        "last_seen_seq": 3,
    })

    local = DeviceCookie.is_valid_locally(cookie_dir)
    assert local is not None
    assert local.get("last_seen_hash") == "abc"
    assert local.get("last_seen_seq") == 3


def test_E5_parse_remote_legacy_tolerated():
    """E5: parse_remote() on a legacy cookie (no staging_hash/seq) returns the
    dict with the new fields absent — no fabrication, no exception."""
    legacy = json.dumps({"device_uuid": "dev-a", "device_specifier": "spec-1"}).encode("utf-8")
    parsed = DeviceCookie.parse_remote(legacy)

    assert parsed is not None
    assert parsed["device_uuid"] == "dev-a"
    assert parsed["device_specifier"] == "spec-1"
    assert "staging_hash" not in parsed
    assert "seq" not in parsed


def test_E6_parse_remote_full_and_invalid():
    """E6: parse_remote() on a full cookie returns staging_hash + seq verbatim;
    invalid bytes → None (unchanged)."""
    full = json.dumps({
        "device_uuid": "dev-a",
        "device_specifier": "spec-1",
        "staging_hash": "h" * 64,
        "seq": 5,
    }).encode("utf-8")
    parsed = DeviceCookie.parse_remote(full)

    assert parsed is not None
    assert parsed["staging_hash"] == "h" * 64
    assert parsed["seq"] == 5

    assert DeviceCookie.parse_remote(b"\xff\xfe\xfd") is None


# ──────────────────────────────────────────────────────────────────────────
# Group J-client — seq bump
# ──────────────────────────────────────────────────────────────────────────


def test_J11_next_seq_increment_base():
    """J11: DeviceCookie.next_seq(last_seen_seq): None → 1; N → N+1."""
    assert DeviceCookie.next_seq(None) == 1
    assert DeviceCookie.next_seq(0) == 1
    assert DeviceCookie.next_seq(5) == 6
