#!/usr/bin/env python3
"""adb automation: Create New Ledger → Tasks → Commit → Push → Export → Validate.

Full flow:
  Phase 1 — Create New Ledger (steps 1–6):
    1. Wipe app data + launch
    2. Navigate landing → New Ledger
    3. Onboarding: Create New Ledger → passphrase → create
    4. Confirm seed saved → Continue → Dashboard

  Phase 2 — Create Tasks (steps 7–10):
    5. Create "Test01" (tag: testing, comment: onboarding from fresh ledger)
    6. Create "Test02" (same, 3s after Test01)
    7. Run both concurrently for 60s
    8. End both tasks

  Phase 3 — Commit + Push (steps 11–13):
    9. Navigate to Sync tab
    10. Commit to Local Ledger
    11. Push Ledger to Cloud

  Phase 4 — Export + Validate (steps 14–16):
    12. Pull SQLite database from device via adb
    13. Validate chain integrity (prev_hash linkage, block count, entry count)
    14. Report results

Reads TEST_CREDENTIALS.md for passphrase / Worker config.
Requires: adb connected to target emulator/device, debug-mode Flutter APK.

Usage:
    python3 scripts/adb_onboard_create.py [--device DEVICE_SERIAL]
"""

import argparse
import base64
import json
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CREDS_PATH = REPO_ROOT / "TEST_CREDENTIALS.md"
PACKAGE = "com.phpoc.phpoc_flutter"
DB_PATH = f"/data/data/{PACKAGE}/app_flutter/phpoc.db"


# ── Credential parsing ─────────────────────────────────────────────

def parse_credentials() -> dict[str, str]:
    """Extract key-value pairs from TEST_CREDENTIALS.md markdown table."""
    text = CREDS_PATH.read_text()
    creds: dict[str, str] = {}

    for m in re.finditer(
        r'\|\s*\*\*(Passphrase|Worker URL|Worker API Key)\*\*\s*\|\s*`([^`]+)`',
        text,
    ):
        key, value = m.group(1), m.group(2)
        if key == "Passphrase":
            creds["passphrase"] = value
        elif key == "Worker URL":
            creds["worker_url"] = value
        elif key == "Worker API Key":
            creds["api_key"] = value

    required = ["passphrase", "worker_url", "api_key"]
    missing = [k for k in required if k not in creds]
    if missing:
        print(f"❌ Missing credentials: {missing}")
        print(f"   Parsed from {CREDS_PATH}")
        sys.exit(1)

    return creds


# ── Adb helpers ────────────────────────────────────────────────────

class Adb:
    """Thin wrapper around adb commands."""

    def __init__(self, device: str | None = None):
        self.prefix = ["adb"]
        if device:
            self.prefix += ["-s", device]

    def _run(self, *args: str, timeout: int = 10) -> str:
        try:
            r = subprocess.run(
                [*self.prefix, *args],
                capture_output=True, text=True, timeout=timeout,
            )
            return r.stdout + r.stderr
        except subprocess.TimeoutExpired:
            print(f"⚠️  Timeout: adb {' '.join(args)}")
            return ""

    def shell(self, cmd: str, timeout: int = 10) -> str:
        return self._run("shell", cmd, timeout=timeout)

    def tap(self, x: int, y: int):
        self.shell(f"input tap {x} {y}")

    def text(self, s: str):
        """Type text via adb input. Spaces are escaped as %s."""
        escaped = s.replace(" ", r"%s")
        self.shell(f"input text {escaped}")

    def keyevent(self, code: int):
        self.shell(f"input keyevent {code}")

    def wipe(self):
        self.shell(f"pm clear {PACKAGE}")
        print("  ✅ App data wiped")

    def start(self):
        self.shell(f"am start -n {PACKAGE}/.MainActivity", timeout=5)

    def dump_ui(self) -> str:
        """Dump UI hierarchy and return XML string."""
        self.shell("uiautomator dump /sdcard/ui_auto.xml", timeout=5)
        time.sleep(0.3)
        return self.shell("cat /sdcard/ui_auto.xml", timeout=5)

    def visible_texts(self) -> list[str]:
        """Return all visible content-desc, text, and hint values."""
        xml = self.dump_ui()
        descs = re.findall(r'content-desc="([^"]*)"', xml)
        texts = re.findall(r'text="([^"]*)"', xml)
        hints = re.findall(r'hint="([^"]*)"', xml)
        return [d for d in descs if d] + [t for t in texts if t] + [h for h in hints if h]

    def wait_for_text(self, expected: str, timeout_s: int = 30) -> bool:
        """Poll until expected text appears in UI."""
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            texts = self.visible_texts()
            if any(expected in t for t in texts):
                return True
            time.sleep(1)
        return False

    def _score_match(self, node_xml: str) -> int:
        """Score a match node: higher = better tap target."""
        score = 0
        if 'clickable="true"' in node_xml:
            score += 10
        if 'class="android.widget.Button"' in node_xml:
            score += 5
        if 'enabled="true"' in node_xml:
            score += 2
        by = re.search(r'bounds="\[(\d+),(\d+)\]', node_xml)
        if by:
            score += int(by.group(2)) // 100
        return score

    def wait_and_tap(self, desc: str, timeout_s: int = 20) -> bool:
        """Wait for a tappable element matching desc (content-desc, text, or hint) and tap its center."""
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            xml = self.dump_ui()
            candidates: list[tuple[int, int, int, int, int]] = []
            seen_bounds: set[tuple[int, int, int, int]] = set()

            for attr in ('content-desc', 'text', 'hint'):
                for m in re.finditer(
                    rf'<node\b[^<>]*\b{attr}="[^"]*{re.escape(desc)}[^"]*"[^<>]*/?>',
                    xml,
                ):
                    node_xml = m.group(0)
                    bm = re.search(
                        r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                        node_xml,
                    )
                    if not bm:
                        continue
                    x1, y1, x2, y2 = map(int, bm.groups())
                    b = (x1, y1, x2, y2)
                    if b in seen_bounds:
                        continue
                    seen_bounds.add(b)
                    score = self._score_match(node_xml)
                    candidates.append((score, x1, y1, x2, y2))

            if candidates:
                _, x1, y1, x2, y2 = max(candidates, key=lambda c: c[0])
                cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
                self.tap(cx, cy)
                return True
            time.sleep(1)
        print(f"  ❌ Timed out waiting for '{desc}'")
        return False

    def find_all_bounds(self, desc: str) -> list[tuple[int, int, int, int]]:
        """Find all UI elements whose content-desc, text, or hint contains `desc`."""
        xml = self.dump_ui()
        results: list[tuple[int, int, int, int]] = []
        seen: set[tuple[int, int, int, int]] = set()
        for attr in ('content-desc', 'text', 'hint'):
            for m in re.finditer(
                rf'<node\b[^<>]*\b{attr}="[^"]*{re.escape(desc)}[^"]*"[^<>]*/?>',
                xml,
            ):
                node_xml = m.group(0)
                bm = re.search(
                    r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                    node_xml,
                )
                if bm:
                    b = tuple(map(int, bm.groups()))
                    if b not in seen:
                        seen.add(b)
                        results.append(b)
        return results

    def find_edittext_centers(self) -> list[tuple[int, int, str]]:
        """Return list of (cx, cy, hint) for all visible EditText fields."""
        xml = self.dump_ui()
        results: list[tuple[int, int, str]] = []
        for m in re.finditer(
            r'<node[^>]*class="android\.widget\.EditText"'
            r'[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
            r'[^>]*hint="([^"]*)"',
            xml,
        ):
            x1, y1, x2, y2 = map(int, m.groups()[:4])
            hint = m.group(5)
            results.append(((x1 + x2) // 2, (y1 + y2) // 2, hint))
        return results

    def clear_and_type(self, x: int, y: int, text: str, clear_del_count: int = 50):
        """Tap a field at (x, y), clear existing text, and type new text."""
        self.tap(x, y)
        time.sleep(0.3)
        self.shell(
            f"for i in $(seq 1 {clear_del_count}); do input keyevent 67; done",
            timeout=clear_del_count // 10 + 3,
        )
        time.sleep(0.1)
        self.text(text)

    def pull_db(self, dest_dir: Path) -> bool:
        """Pull all SQLite files (db, wal, shm) from the device via run-as + cat.

        Pulls phpoc.db, phpoc.db-wal, and phpoc.db-shm into dest_dir.
        SQLite will automatically read from the WAL when all three files
        are present together (no explicit checkpoint needed).
        Returns True if at least the main db was pulled successfully.
        """
        dest_dir.mkdir(parents=True, exist_ok=True)
        success = False

        for suffix in ["", "-wal", "-shm"]:
            remote = f"app_flutter/phpoc.db{suffix}"
            dest = dest_dir / f"phpoc.db{suffix}"
            try:
                r = subprocess.run(
                    [*self.prefix, "shell", f"run-as {PACKAGE} cat {remote}"],
                    capture_output=True, timeout=15,
                )
                raw = r.stdout
                if not raw or len(raw) < 10:
                    raw = r.stderr
                if raw and len(raw) > 10:
                    dest.write_bytes(raw)
            except subprocess.TimeoutExpired:
                print(f"  ⚠️  Timeout pulling {remote}")

        main_db = dest_dir / "phpoc.db"
        if main_db.exists() and main_db.stat().st_size > 100:
            total = main_db.stat().st_size
            for s in ["-wal", "-shm"]:
                p = dest_dir / f"phpoc.db{s}"
                if p.exists():
                    total += p.stat().st_size
            print(f"  ✅ Database pulled ({total} bytes)")
            return True

        print("  ❌ Failed to pull database")
        return False


# ── High-level task actions ────────────────────────────────────────

def create_task(adb: Adb, title: str, tags: str, comment: str) -> bool:
    """Create a task via the Dashboard 'New Task' form."""
    texts = adb.visible_texts()
    form_expanded = any(s in t for t in texts for s in ("Cancel", "Start"))

    if form_expanded:
        print(f"    ℹ️  Form already expanded — dismissing for clean slate")
        _dismiss_form(adb)
        time.sleep(0.5)

    if not adb.wait_and_tap("New Task", timeout_s=10):
        print(f"    ❌ Could not expand New Task panel for '{title}'")
        return False
    time.sleep(1.0)

    fields = adb.find_edittext_centers()
    if len(fields) < 3:
        print(f"    ❌ Expected 3 form fields, found {len(fields)}")
        return False

    # Title
    cx, cy, _ = fields[0]
    adb.clear_and_type(cx, cy, title)
    time.sleep(0.2)

    # Tags
    cx, cy, _ = fields[1]
    adb.clear_and_type(cx, cy, tags)
    time.sleep(0.2)

    # Comment
    cx, cy, _ = fields[2]
    adb.clear_and_type(cx, cy, comment)
    time.sleep(0.2)

    # Start
    if not adb.wait_and_tap("Start", timeout_s=5):
        print(f"    ❌ Could not find Start button for '{title}'")
        _dismiss_form(adb)
        return False
    time.sleep(1)

    if adb.wait_for_text(title, timeout_s=5):
        print(f"    ✅ Task '{title}' created")
        return True
    else:
        print(f"    ⚠️  Task '{title}' may have been created but title not visible")
        return True


def _dismiss_form(adb: Adb):
    if adb.wait_and_tap("Cancel", timeout_s=3):
        time.sleep(0.5)
        print("    ℹ️  Form dismissed")


def _find_running_task_cards(adb: Adb) -> list[tuple[int, int, int, int]]:
    return adb.find_all_bounds("Elapsed")


def end_all_tasks(adb: Adb) -> int:
    """End all active tasks by tapping their Stop buttons."""
    cards = _find_running_task_cards(adb)
    if not cards:
        print("    ⚠️  No running task cards found")
        return 0

    cards.sort(key=lambda b: b[1])
    xml = adb.dump_ui()

    stopped = 0
    for card_x1, card_y1, card_x2, card_y2 in cards:
        buttons: list[tuple[int, int, int, int]] = []
        for m in re.finditer(
            r'<node[^>]*clickable="true"'
            r'[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            xml,
        ):
            bx1, by1, bx2, by2 = map(int, m.groups())
            if by1 >= card_y1 and by2 <= card_y2 and bx1 > 800:
                buttons.append((bx1, by1, bx2, by2))

        if buttons:
            buttons.sort(key=lambda b: b[0])
            bx1, by1, bx2, by2 = buttons[-1]
            cx, cy = (bx1 + bx2) // 2, (by1 + by2) // 2
            adb.tap(cx, cy)
            stopped += 1
            time.sleep(1)

    if stopped > 0:
        print(f"    ✅ Ended {stopped} task(s)")
    else:
        print("    ⚠️  No Stop buttons found on task cards")
    return stopped


# ── Phase 1: Create New Ledger ─────────────────────────────────────

def run_create_new_ledger(adb: Adb, creds: dict[str, str]) -> bool:
    """Create a brand-new ledger via the onboarding flow."""
    passphrase = creds["passphrase"]

    # ── Step 1: Wipe + Start ──────────────────────────────────
    print("\n📱 Step 1: Wipe app data and launch")
    adb.wipe()
    time.sleep(1)
    adb.start()
    time.sleep(4)

    # ── Step 2: Landing → New Ledger ──────────────────────────
    print("\n📋 Step 2: Landing → New Ledger")
    if not adb.wait_and_tap("New Ledger", timeout_s=10):
        print("❌ Could not find 'New Ledger' button on landing screen")
        return False
    time.sleep(2)
    print("  ✅ Onboarding screen appeared")

    # ── Step 3: Create New Ledger → Passphrase ────────────────
    print("\n🔑 Step 3: Create New Ledger → enter passphrase")
    # Tap "Create New Ledger" card
    if not adb.wait_and_tap("Create New Ledger", timeout_s=10):
        print("❌ Could not find 'Create New Ledger' card")
        return False
    time.sleep(2)

    # Check for wipe-confirmation dialog (shouldn't appear on fresh install)
    texts = adb.visible_texts()
    if any("Delete & Continue" in t for t in texts):
        print("  ℹ️  Wipe confirmation dialog appeared — accepting")
        if not adb.wait_and_tap("Delete & Continue", timeout_s=5):
            print("❌ Could not tap 'Delete & Continue'")
            return False
        time.sleep(1)

    # Should be on passphrase screen now
    if not adb.wait_for_text("Create a Passphrase", timeout_s=10):
        print("❌ Passphrase screen did not appear")
        texts = adb.visible_texts()
        print(f"  Visible: {[t for t in texts if t][:10]}")
        return False
    print("  ✅ Passphrase screen appeared")

    # Type passphrase into auto-focused field
    time.sleep(0.5)
    adb.text(passphrase)
    time.sleep(0.5)

    # Tap "Create" button
    if not adb.wait_and_tap("Create", timeout_s=5):
        print("❌ Could not find 'Create' button")
        return False
    print("  ✅ 'Create' tapped — generating seed…")
    time.sleep(3)

    # ── Step 4: Seed Display → Confirm ────────────────────────
    print("\n🌱 Step 4: Confirm seed saved")
    if not adb.wait_for_text("Your Recovery Seed", timeout_s=15):
        print("❌ Seed display screen did not appear")
        texts = adb.visible_texts()
        print(f"  Visible: {[t for t in texts if t][:10]}")
        return False
    print("  ✅ Seed displayed")

    # The seed text is available as a SelectableText — extract to verify
    texts = adb.visible_texts()
    seed_candidates = [t for t in texts if len(t) > 30 and "/" in t or "+" in t]
    if seed_candidates:
        print(f"  ℹ️  Seed: {seed_candidates[0][:20]}…")

    # Check the acknowledgment checkbox
    if not adb.wait_and_tap("I have saved my recovery seed in a safe place", timeout_s=10):
        print("❌ Could not find seed acknowledgment checkbox")
        return False
    time.sleep(0.5)
    print("  ✅ Seed acknowledged")

    # Tap "Continue"
    if not adb.wait_and_tap("Continue", timeout_s=5):
        print("❌ Could not find 'Continue' button")
        return False
    time.sleep(3)
    print("  ✅ Onboarding complete")

    # ── Step 5: Unlock ────────────────────────────────────────
    print("\n🔐 Step 5: Unlock")
    if not adb.wait_for_text("Unlock", timeout_s=10):
        texts = adb.visible_texts()
        print(f"  ⚠️  Unlock screen not detected. Visible: {[t for t in texts if t][:10]}")
        time.sleep(2)
        if not adb.wait_for_text("Unlock", timeout_s=5):
            print("  ❌ Unlock screen not reachable")
            return False

    time.sleep(1)
    adb.text(passphrase)
    time.sleep(0.5)

    if not adb.wait_and_tap("Unlock", timeout_s=10):
        print("❌ Could not tap Unlock button")
        return False
    time.sleep(3)
    print("  ✅ Unlocked")

    # ── Step 6: Configure Worker ─────────────────────────────
    print("\n⚙️  Step 6: Configure Worker (Settings)")
    time.sleep(1)

    # Navigate to Settings tab
    if not adb.wait_and_tap("Settings", timeout_s=10):
        print("  ⚠️  Could not find Settings tab — skipping Worker config")
    else:
        time.sleep(2)
        print("  ✅ On Settings screen")

        # Tap "Worker" to expand the editor
        if not adb.wait_and_tap("Worker", timeout_s=10):
            print("  ⚠️  Could not find Worker section")
        else:
            time.sleep(1)
            print("  ✅ Worker editor expanded")

            # Find EditText fields — first is URL, second is API Key
            fields = adb.find_edittext_centers()
            if len(fields) >= 2:
                # Type Worker URL
                cx, cy, _ = fields[0]
                adb.clear_and_type(cx, cy, creds["worker_url"])
                time.sleep(0.3)
                print(f"  ✅ Worker URL entered")

                # Type API Key
                cx, cy, _ = fields[1]
                adb.clear_and_type(cx, cy, creds["api_key"])
                time.sleep(0.3)
                print(f"  ✅ API Key entered")

                # Tap Save
                if adb.wait_and_tap("Save", timeout_s=5):
                    time.sleep(2)
                    print("  ✅ Worker config saved")
                else:
                    print("  ⚠️  Could not tap Save")
            else:
                print(f"  ⚠️  Expected 2 fields, found {len(fields)}")

        # Navigate back to Dashboard
        if not adb.wait_and_tap("Dashboard", timeout_s=10):
            print("  ⚠️  Could not return to Dashboard")
        time.sleep(2)

    # ── Step 7: Verify Dashboard ──────────────────────────────
    print("\n🏠 Step 7: Verify Dashboard")
    if not adb.wait_for_text("Dashboard", timeout_s=10):
        texts = adb.visible_texts()
        print(f"  ⚠️  Dashboard not detected. Visible: {[t for t in texts if t][:10]}")
        time.sleep(2)
        if not adb.wait_for_text("Dashboard", timeout_s=5):
            print("  ❌ Dashboard not reachable")
            return False
    print("  ✅ On Dashboard — new ledger ready")

    return True


# ── Phase 4: Chain Validation ──────────────────────────────────────

def validate_chain(db_path: Path) -> dict:
    """Validate the ledger chain from the pulled SQLite database.

    The Flutter app stores block data as base64-encoded JSON in
    ``data_enc``. Seal hashes (day_hash, year_hash, etc.) live inside
    the decoded JSON. We extract them to verify prev_hash linkage.

    Checks:
      1. Block count > 0
      2. Genesis block exists (type='genesis', block_index=0)
      3. prev_hash linkage using seal hashes from decoded data_enc
      4. Entry count from decoded data_enc
      5. block_id / identity_seal consistency warnings

    Returns a dict with validation results.
    """
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row

    result = {
        "valid": False,
        "block_count": 0,
        "entry_count": 0,
        "genesis_ok": False,
        "chain_linked": False,
        "errors": [],
        "warnings": [],
        "blocks": [],
    }

    try:
        # ── Read blocks ───────────────────────────────────────
        rows = conn.execute(
            "SELECT block_id, block_type, block_index, prev_hash, "
            "identity_seal, data_enc, key_version, created_at FROM blocks"
            " ORDER BY block_index"
        ).fetchall()

        result["block_count"] = len(rows)

        if len(rows) == 0:
            result["errors"].append("No blocks found in database")
            return result

        # ── Genesis check ──────────────────────────────────────
        genesis = rows[0]
        if genesis["block_type"] != "genesis":
            result["errors"].append(
                f"First block is '{genesis['block_type']}', expected 'genesis'"
            )
        elif genesis["block_index"] != 0:
            result["errors"].append(
                f"Genesis block_index={genesis['block_index']}, expected 0"
            )
        else:
            result["genesis_ok"] = True

        # ── Build block list ───────────────────────────────────
        # SEAL_FIELD_NAMES: ordered by priority — first match wins.
        SEAL_FIELD_NAMES = ("day_hash", "year_hash", "month_hash", "block_hash")

        total_entries = 0
        blocks = []
        for row in rows:
            # ── Decode data_enc (base64 → JSON) ────────────────
            parsed: dict = {}
            try:
                raw = base64.b64decode(row["data_enc"])
                parsed = json.loads(raw.decode("utf-8"))
            except Exception:
                pass

            # ── True block type (JSON wins over SQL column) ───
            json_type = parsed.get("type")
            sql_type = row["block_type"]
            if json_type and json_type != sql_type:
                result["warnings"].append(
                    f"Block idx={row['block_index']}: "
                    f"SQL type='{sql_type}' but data_enc type='{json_type}'"
                )
            block_type = json_type or sql_type

            # ── Seal hash (from JSON, then SQL block_id) ───────
            seal = None
            seal_field = None
            for name in SEAL_FIELD_NAMES:
                if name in parsed:
                    seal = parsed[name]
                    seal_field = name
                    break
            if not seal:
                seal = row["block_id"] or None
                if seal:
                    seal_field = "block_id (SQL)"

            # ── Entries ────────────────────────────────────────
            entries_raw = parsed.get("entries", [])
            entry_count = len(entries_raw)
            total_entries += entry_count
            entry_titles = []
            for e in entries_raw[:5]:
                if isinstance(e, dict):
                    inner = e.get("data", e)
                    title = inner.get("title", "?")
                    dur = inner.get("duration", 0)
                    entry_titles.append(f"{title} ({dur // 1000}s)")
                else:
                    entry_titles.append(str(e)[:40])

            blocks.append({
                "block_id": row["block_id"],
                "block_type": block_type,
                "block_index": row["block_index"],
                "prev_hash": row["prev_hash"],
                "seal": seal,
                "seal_field": seal_field,
                "identity_seal": row["identity_seal"],
                "entry_count": entry_count,
                "entry_titles": entry_titles,
            })

        result["blocks"] = blocks
        result["entry_count"] = total_entries

        # ── prev_hash linkage ──────────────────────────────────
        chain_ok = True
        for i in range(1, len(blocks)):
            prev_seal = blocks[i - 1]["seal"]
            curr_prev = blocks[i]["prev_hash"]
            if prev_seal and curr_prev:
                if prev_seal != curr_prev:
                    result["errors"].append(
                        f"Block {i} (idx={blocks[i]['block_index']}, "
                        f"{blocks[i]['block_type']}): "
                        f"prev_hash={curr_prev[:16]}… "
                        f"≠ Block {i - 1} seal={prev_seal[:16]}…"
                    )
                    chain_ok = False
            elif not prev_seal:
                result["warnings"].append(
                    f"Block {i - 1} has no seal hash — "
                    f"cannot verify Block {i} prev_hash"
                )
                chain_ok = False

        if chain_ok and len(blocks) > 1:
            result["chain_linked"] = True

        # ── SQL block_id vs seal consistency ──────────────────
        for b in blocks:
            if b["block_id"] and b["seal"] and b["seal_field"] != "block_id (SQL)":
                if b["block_id"] != b["seal"]:
                    result["warnings"].append(
                        f"Block idx={b['block_index']}: "
                        f"SQL block_id ≠ {b['seal_field']}"
                    )
            if not b["block_id"] and b["block_type"] != "genesis":
                result["warnings"].append(
                    f"Block idx={b['block_index']} ({b['block_type']}): "
                    f"SQL block_id is empty (should mirror {b['seal_field']})"
                )

        # ── Missing identity_seal warning ──────────────────────
        missing_identity = [
            b["block_index"] for b in blocks
            if not b["identity_seal"] and b["block_type"] != "genesis"
        ]
        if missing_identity:
            result["warnings"].append(
                f"Blocks missing identity_seal: {missing_identity} "
                f"(identity_seal is optional per spec, required for multi-device)"
            )

        # ── Overall validity ───────────────────────────────────
        result["valid"] = (
            result["genesis_ok"]
            and result["chain_linked"]
            and result["block_count"] > 0
            and len(result["errors"]) == 0
        )

    except Exception as e:
        result["errors"].append(f"Validation exception: {e}")
    finally:
        conn.close()

    return result


def print_validation_report(result: dict):
    """Pretty-print the validation report."""
    print("\n" + "=" * 60)
    print("CHAIN VALIDATION REPORT")
    print("=" * 60)

    status = "✅ VALID" if result["valid"] else "❌ INVALID"
    print(f"\n  Overall:   {status}")
    print(f"  Blocks:    {result['block_count']}")
    print(f"  Entries:   {result['entry_count']}")

    checks = [
        ("Genesis block", result["genesis_ok"]),
        ("Chain linked (prev_hash)", result["chain_linked"]),
    ]
    for label, ok in checks:
        icon = "✅" if ok else "❌"
        print(f"  {icon} {label}")

    if result["blocks"]:
        print(f"\n  Block chain:")
        for i, b in enumerate(result["blocks"]):
            bt = b["block_type"]
            bi = b["block_index"]
            seal = (b.get("seal") or "?")[:16]
            prev = (b["prev_hash"] or "?")[:16]
            ec = b.get("entry_count", 0)
            sf = b.get("seal_field", "?")
            missing = " ⚠️ NO SEAL" if not b.get("seal") and bt != "genesis" else ""
            print(f"    [{i}] {bt:12s} idx={bi:3d}  seal({sf})={seal}…  prev={prev}…  entries={ec}{missing}")
            if b.get("entry_titles"):
                for t in b["entry_titles"]:
                    print(f"         └─ {t}")

    if result["errors"]:
        print(f"\n  ❌ Errors ({len(result['errors'])}):")
        for e in result["errors"]:
            print(f"     • {e}")

    if result["warnings"]:
        print(f"\n  ⚠️  Warnings ({len(result['warnings'])}):")
        for w in result["warnings"]:
            print(f"     • {w}")


# ── Main flow ──────────────────────────────────────────────────────

def run_full_flow(adb: Adb, creds: dict[str, str]) -> bool:
    """Run the complete create → tasks → commit → push → validate flow."""
    passphrase = creds["passphrase"]

    # ═══════════════════════════════════════════════════════════
    # PHASE 1: Create New Ledger
    # ═══════════════════════════════════════════════════════════
    print("=" * 60)
    print("PHASE 1: Create New Ledger")
    print("=" * 60)

    if not run_create_new_ledger(adb, creds):
        print("\n❌ Phase 1 failed — cannot continue")
        return False

    # ═══════════════════════════════════════════════════════════
    # PHASE 2: Create Tasks + Run + End
    # ═══════════════════════════════════════════════════════════
    print("\n" + "=" * 60)
    print("PHASE 2: Create Tasks → Run → End")
    print("=" * 60)

    # Create Test01
    print("\n📝 Create task 'Test01'")
    if not create_task(
        adb,
        title="Test01",
        tags="testing",
        comment="testing full onboarding from fresh ledger",
    ):
        print("  ❌ Failed to create Test01")
        return False

    # Create Test02
    print("\n📝 Create task 'Test02'")
    time.sleep(3)
    if not create_task(
        adb,
        title="Test02",
        tags="testing",
        comment="testing full onboarding from fresh ledger",
    ):
        print("  ❌ Failed to create Test02")
        return False

    # Run both for 60s
    RUN_DURATION = 60
    print(f"\n⏱️  Running both tasks for {RUN_DURATION}s…")
    for remaining in range(RUN_DURATION, 0, -10):
        print(f"    {remaining}s remaining…")
        time.sleep(10)
    print("  ✅ 60s elapsed")

    # End both tasks
    print("\n🛑 Ending all tasks")
    ended = end_all_tasks(adb)
    if ended < 2:
        print(f"  ⚠️  Expected 2 tasks to end, got {ended}")
    time.sleep(2)

    # Verify tasks appear
    texts = adb.visible_texts()
    t1 = any("Test01" in t for t in texts)
    t2 = any("Test02" in t for t in texts)
    print(f"  Tasks visible: Test01={'✅' if t1 else '❌'}, Test02={'✅' if t2 else '❌'}")

    # ═══════════════════════════════════════════════════════════
    # PHASE 3: Commit + Push
    # ═══════════════════════════════════════════════════════════
    print("\n" + "=" * 60)
    print("PHASE 3: Commit + Push")
    print("=" * 60)

    # Navigate to Sync
    print("\n📂 Navigating to Sync tab")
    time.sleep(1)
    if not adb.wait_and_tap("Sync", timeout_s=10):
        print("  Trying navigation drawer…")
        adb.tap(50, 150)
        time.sleep(1)
        if not adb.wait_and_tap("Sync", timeout_s=10):
            print("❌ Could not find Sync navigation")
            return False
    time.sleep(2)
    print("  ✅ On Sync screen")

    # Commit
    print("\n📝 Commit to Local Ledger")
    if adb.wait_and_tap("Commit to Local Ledger", timeout_s=10):
        time.sleep(3)
        texts = adb.visible_texts()
        errors = [t for t in texts if "fail" in t.lower() or "error" in t.lower() or "mismatch" in t.lower()]
        if errors:
            print(f"  ❌ Commit errors: {errors}")
        else:
            print("  ✅ Commit appears successful")
    else:
        print("  ⚠️  'Commit to Local Ledger' button not found")

    # Push
    print("\n☁️  Push Ledger to Cloud")
    if adb.wait_and_tap("Push Ledger to Cloud", timeout_s=10):
        print("  ✅ Push button tapped — waiting…")
        time.sleep(5)
        texts = adb.visible_texts()
        pushed = [t for t in texts if "pushed" in t.lower() or "blocks" in t.lower()]
        if pushed:
            print(f"  ✅ Push result: {pushed}")
        else:
            print(f"  ℹ️  Push ran — output: {[t for t in texts if t][-10:]}")
    else:
        print("  ⚠️  'Push Ledger to Cloud' button not found")

    # ═══════════════════════════════════════════════════════════
    # PHASE 4: Export + Validate
    # ═══════════════════════════════════════════════════════════
    print("\n" + "=" * 60)
    print("PHASE 4: Export + Validate Chain")
    print("=" * 60)

    print("\n💾 Pulling database from device…")
    db_dir = Path(tempfile.mkdtemp(prefix="phpoc_db_"))

    try:
        if not adb.pull_db(db_dir):
            print("  ❌ Could not export database from device")
            return False

        print("\n🔍 Validating chain integrity…")
        result = validate_chain(db_dir / "phpoc.db")
        print_validation_report(result)

        if result["valid"]:
            print("\n🎉 Ledger created, tasks captured, chain is VALID!")
        else:
            print("\n⚠️  Ledger created but chain has integrity issues (see above).")

        return result["valid"]

    finally:
        import shutil
        if db_dir.exists():
            shutil.rmtree(db_dir, ignore_errors=True)


# ── Main ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="adb automation: Create New Ledger → Tasks → Commit → Push → Validate",
    )
    parser.add_argument("--device", "-d", help="adb device serial")
    args = parser.parse_args()

    creds = parse_credentials()
    print(f"✅ Parsed credentials from {CREDS_PATH}")

    adb = Adb(device=args.device)

    success = run_full_flow(adb, creds)

    if success:
        print("\n🎉 Full flow complete — chain VALID!")
    else:
        print("\n❌ Flow complete with validation failures — check output above")
        sys.exit(1)


if __name__ == "__main__":
    main()
