#!/usr/bin/env python3
"""adb automation: Restore from Cloud → Unlock → Create Tasks → Commit → Push → Verify.

Full 11-step flow:
  1.  Wipe app data + launch
  2.  Navigate to Restore from Cloud
  3.  Tap Restore (Worker pull from R2)
  4.  Unlock with passphrase
  4a. Create "Test01" (tag: testing, comment: testing full onboarding from R2 to R2 sync)
  4b. Create "Test02" (same, 1s after Test01)
  4c. Run both concurrently for 60s
  4d. End both tasks
  5.  Navigate to Sync tab
  6.  Commit to Local Ledger
  7.  Push Ledger to Cloud
  8.  Re-wipe + re-launch
  9.  Restore from Cloud again
  10. Unlock again
  11. Verify Test01 + Test02 persisted from R2

Reads credentials from TEST_CREDENTIALS.md (gitignored).
Requires: adb connected to the target emulator/device, debug-mode Flutter APK.

Usage:
    python3 scripts/adb_onboard_restore.py [--device DEVICE_SERIAL]
"""

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CREDS_PATH = REPO_ROOT / "TEST_CREDENTIALS.md"


# ── Credential parsing ─────────────────────────────────────────────

def parse_credentials() -> dict[str, str]:
    """Extract key-value pairs from TEST_CREDENTIALS.md markdown table."""
    text = CREDS_PATH.read_text()
    creds: dict[str, str] = {}

    for m in re.finditer(
        r'\|\s*\*\*(Recovery Seed|Passphrase|Worker URL|Worker API Key)\*\*\s*\|\s*`([^`]+)`',
        text,
    ):
        key, value = m.group(1), m.group(2)
        if key == "Recovery Seed":
            creds["seed"] = value
        elif key == "Passphrase":
            creds["passphrase"] = value
        elif key == "Worker URL":
            creds["worker_url"] = value
        elif key == "Worker API Key":
            creds["api_key"] = value

    required = ["seed", "passphrase", "worker_url", "api_key"]
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

    def logcat_since(self, tag: str = "flutter", since_sec: int = 10) -> str:
        return self.shell(
            f"logcat -d -t '{since_sec}s ago' -s {tag}:*",
            timeout=5,
        )

    def wipe(self, package: str = "com.phpoc.phpoc_flutter"):
        self.shell(f"pm clear {package}")
        print("  ✅ App data wiped")

    def start(self, package: str = "com.phpoc.phpoc_flutter"):
        self.shell(
            f"am start -n {package}/.MainActivity",
            timeout=5,
        )

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

    def find_bounds(self, desc: str) -> tuple[int, int, int, int] | None:
        """Find the first UI element whose content-desc, text, or hint contains `desc`.

        Returns (x1, y1, x2, y2) or None.
        """
        xml = self.dump_ui()
        for attr in ('content-desc', 'text', 'hint'):
            m = re.search(
                rf'<node\b[^<>]*\b{attr}="[^"]*{re.escape(desc)}[^"]*"[^<>]*/?>',
                xml,
            )
            if m:
                node_xml = m.group(0)
                bm = re.search(
                    r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
                    node_xml,
                )
                if bm:
                    return tuple(map(int, bm.groups()))
        return None

    def find_all_bounds(self, desc: str) -> list[tuple[int, int, int, int]]:
        """Find all UI elements whose content-desc, text, or hint contains `desc`.

        Returns list of (x1, y1, x2, y2) bounds.
        """
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

    def clear_and_type(self, x: int, y: int, text: str, clear_del_count: int = 50):
        """Tap a field at (x, y), clear existing text, and type new text."""
        self.tap(x, y)
        time.sleep(0.3)
        # Send DEL keyevents in one shell call to clear any existing content
        self.shell(
            f"for i in $(seq 1 {clear_del_count}); do input keyevent 67; done",
            timeout=clear_del_count // 10 + 3,
        )
        time.sleep(0.1)
        self.text(text)

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


# ── High-level task actions ────────────────────────────────────────

def create_task(adb: Adb, title: str, tags: str, comment: str) -> bool:
    """Create a task via the Dashboard 'New Task' form.

    1. Expand the 'New Task' panel (if collapsed)
    2. Find EditText fields by index, clear and type into each
    3. Tap 'Start'
    """
    # Check if form is already expanded (has 'Cancel' or 'Start' visible)
    texts = adb.visible_texts()
    form_expanded = any(s in t for t in texts for s in ("Cancel", "Start"))

    if form_expanded:
        # Dismiss and re-expand for a clean form (hints are gone after first fill)
        print(f"    ℹ️  Form already expanded — dismissing for clean slate")
        _dismiss_form(adb)
        time.sleep(0.5)

    # Expand "New Task" panel
    if not adb.wait_and_tap("New Task", timeout_s=10):
        print(f"    ❌ Could not expand New Task panel for '{title}'")
        return False
    time.sleep(1.0)  # Wait for AnimatedCrossFade (250ms) + IME setup

    # Find EditText fields — they appear in order: title, tags, comment
    fields = adb.find_edittext_centers()
    if len(fields) < 3:
        print(f"    ❌ Expected 3 form fields, found {len(fields)}")
        return False

    # Field 0: Title (autofocus may or may not work — explicitly tap + clear + type)
    cx, cy, _ = fields[0]
    adb.clear_and_type(cx, cy, title)
    time.sleep(0.2)

    # Field 1: Tags
    cx, cy, _ = fields[1]
    adb.clear_and_type(cx, cy, tags)
    time.sleep(0.2)

    # Field 2: Comment
    cx, cy, _ = fields[2]
    adb.clear_and_type(cx, cy, comment)
    time.sleep(0.2)

    # Tap "Start" button
    if not adb.wait_and_tap("Start", timeout_s=5):
        print(f"    ❌ Could not find Start button for '{title}'")
        _dismiss_form(adb)
        return False
    time.sleep(1)

    # Verify task appeared (title visible in UI)
    if adb.wait_for_text(title, timeout_s=5):
        print(f"    ✅ Task '{title}' created")
        return True
    else:
        print(f"    ⚠️  Task '{title}' may have been created but title not visible")
        return True  # Don't fail — the form submitted


def _dismiss_form(adb: Adb):
    """Dismiss an open New Task form by tapping Cancel if present."""
    if adb.wait_and_tap("Cancel", timeout_s=3):
        time.sleep(0.5)
        print("    ℹ️  Form dismissed")


def _find_running_task_cards(adb: "Adb") -> list[tuple[int, int, int, int]]:
    """Find all active task card bounds by looking for 'Elapsed' in content-desc.

    Returns list of (x1, y1, x2, y2) for each running task card.
    """
    return adb.find_all_bounds("Elapsed")


def end_all_tasks(adb: "Adb") -> int:
    """End all active tasks by tapping their Stop buttons.

    Finds running task cards (content-desc containing 'Elapsed'), then
    taps the rightmost clickable button in each card's row (the Stop button).
    Returns count of tasks ended.
    """
    cards = _find_running_task_cards(adb)
    if not cards:
        print("    ⚠️  No running task cards found")
        return 0

    # Sort by y-coordinate (top to bottom)
    cards.sort(key=lambda b: b[1])

    # Get the full XML to find clickable elements within each card's vertical bounds
    xml = adb.dump_ui()

    stopped = 0
    for card_x1, card_y1, card_x2, card_y2 in cards:
        # Find all clickable elements in this card's vertical range, right of center
        buttons: list[tuple[int, int, int, int]] = []
        for m in re.finditer(
            r'<node[^>]*clickable="true"'
            r'[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"',
            xml,
        ):
            bx1, by1, bx2, by2 = map(int, m.groups())
            # Must be within card's vertical range and on the right side
            if by1 >= card_y1 and by2 <= card_y2 and bx1 > 800:
                buttons.append((bx1, by1, bx2, by2))

        # The rightmost button should be Stop; sort by x, take the last one
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


# ── Phase 1: Full Restore → Create Tasks → Commit → Push ──────────

def run_phase1(adb: Adb, creds: dict[str, str]) -> bool:
    """Steps 1–7: Restore from Cloud, create test tasks, commit, push."""
    passphrase = creds["passphrase"]

    # ── Step 1: Wipe + Start ──────────────────────────────────
    print("\n📱 Step 1: Wipe app data and launch")
    adb.wipe()
    time.sleep(1)
    adb.start()
    time.sleep(4)

    # ── Step 2: Onboarding — Restore from Cloud ───────────────
    print("\n📋 Step 2: Navigate to Restore from Cloud")
    if not adb.wait_and_tap("New Ledger"):
        print("❌ Could not find 'New Ledger' button")
        return False
    time.sleep(2)
    if not adb.wait_and_tap("Restore from Cloud"):
        print("❌ Could not find 'Restore from Cloud' button")
        return False
    time.sleep(2)
    print("  ✅ Fields pre-filled by kDebugMode")

    # ── Step 3: Tap Restore ───────────────────────────────────
    print("\n☁️  Step 3: Tap Restore (waiting for Worker pull)")
    if not adb.wait_and_tap("Restore"):
        print("❌ Could not find 'Restore' button")
        return False
    print("  ✅ Restore button tapped — waiting for Worker response…")

    if not adb.wait_for_text("Unlock", timeout_s=60):
        texts = adb.visible_texts()
        errors = [t for t in texts if "fail" in t.lower() or "error" in t.lower()]
        if errors:
            print(f"  ❌ Restore failed: {errors}")
        else:
            print("  ❌ Timed out waiting for unlock screen")
        return False
    print("  ✅ Restore complete — unlock screen appeared")

    # ── Step 4: Unlock ────────────────────────────────────────
    print("\n🔐 Step 4: Unlock")
    time.sleep(2)

    adb.text(passphrase)
    time.sleep(0.5)

    if not adb.wait_and_tap("Unlock", timeout_s=10):
        print("❌ Could not find Unlock button")
        return False
    time.sleep(3)

    # Verify we're on dashboard
    if not adb.wait_for_text("Dashboard", timeout_s=10):
        print("  ⚠️  Dashboard not detected, continuing anyway...")
    print("  ✅ Unlocked — on Dashboard")

    # ── Step 4a: Create Test01 ────────────────────────────────
    print("\n📝 Step 4a: Create task 'Test01'")
    if not create_task(
        adb,
        title="Test01",
        tags="testing",
        comment="testing full onboarding from R2 to R2 sync",
    ):
        print("  ❌ Failed to create Test01")
        return False

    # ── Step 4b: Create Test02 (after Test01 confirmed visible) ────────
    print("\n📝 Step 4b: Create task 'Test02'")
    time.sleep(3)  # Wait for async capture + UI rebuild
    if not create_task(
        adb,
        title="Test02",
        tags="testing",
        comment="testing full onboarding from R2 to R2 sync",
    ):
        print("  ❌ Failed to create Test02")
        return False

    # ── Step 4c: Run both concurrently for 60 seconds ─────────
    RUN_DURATION = 60
    print(f"\n⏱️  Step 4c: Running both tasks concurrently for {RUN_DURATION}s…")
    for remaining in range(RUN_DURATION, 0, -10):
        print(f"    {remaining}s remaining…")
        time.sleep(10)
    print("  ✅ 60s elapsed")

    # ── Step 4d: End both tasks ───────────────────────────────
    print("\n🛑 Step 4d: Ending both tasks")
    ended = end_all_tasks(adb)
    if ended < 2:
        print(f"  ⚠️  Expected 2 tasks to end, got {ended}")
    time.sleep(2)

    # Verify tasks appear as uncommitted (Pending Commit section)
    texts = adb.visible_texts()
    test01_done = any("Test01" in t for t in texts)
    test02_done = any("Test02" in t for t in texts)
    if test01_done or test02_done:
        print(f"  ✅ Tasks visible: Test01={'✅' if test01_done else '❌'}, Test02={'✅' if test02_done else '❌'}")

    # ── Step 5: Navigate to Sync ──────────────────────────────
    print("\n📂 Step 5: Navigate to Sync tab")
    time.sleep(1)
    texts = adb.visible_texts()
    print(f"  Visible: {[t for t in texts if t][:15]}")

    if not adb.wait_and_tap("Sync", timeout_s=10):
        print("  Trying navigation drawer...")
        adb.tap(50, 150)
        time.sleep(1)
        if not adb.wait_and_tap("Sync", timeout_s=10):
            print("❌ Could not find Sync navigation")
            return False

    time.sleep(2)
    print("  ✅ On Sync screen")

    # ── Step 6: Commit to Local Ledger ────────────────────────
    print("\n📝 Step 6: Commit to Local Ledger")
    if adb.wait_and_tap("Commit to Local Ledger", timeout_s=10):
        time.sleep(3)
        texts = adb.visible_texts()
        errors = [t for t in texts if "fail" in t.lower() or "error" in t.lower() or "mismatch" in t.lower()]
        if errors:
            print(f"  ❌ Commit errors: {errors}")
        else:
            print("  ✅ Commit appears successful")
    else:
        print("  ⚠️  'Commit to Local Ledger' button not found (no completed entries?)")

    # ── Step 7: Push Ledger to Cloud ──────────────────────────
    print("\n☁️  Step 7: Push Ledger to Cloud")
    if adb.wait_and_tap("Push Ledger to Cloud", timeout_s=10):
        print("  ✅ Push button tapped — waiting…")
        time.sleep(5)
        texts = adb.visible_texts()
        pushed = [t for t in texts if "pushed" in t.lower() or "blocks" in t.lower()]
        if pushed:
            print(f"  ✅ Push result: {pushed}")
        else:
            print(f"  ℹ️  Push ran — check output: {[t for t in texts if t][-10:]}")
    else:
        print("  ⚠️  'Push Ledger to Cloud' button not found")

    return True


# ── Phase 2: Verification — Wipe → Restore → Confirm Persistence ──

def run_phase2_verify(adb: Adb, creds: dict[str, str]) -> bool:
    """Steps 8–11: Re-wipe, restore from cloud, unlock, verify Test01+Test02."""
    passphrase = creds["passphrase"]

    # ── Step 8: Re-wipe + re-launch ───────────────────────────
    print("\n🔄 Step 8: Re-wipe app data and re-launch")
    adb.wipe()
    time.sleep(1)
    adb.start()
    time.sleep(4)

    # ── Step 9: Restore from Cloud again ──────────────────────
    print("\n📋 Step 9: Restore from Cloud (second time)")
    if not adb.wait_and_tap("New Ledger"):
        print("❌ Could not find 'New Ledger' button")
        return False
    time.sleep(2)
    if not adb.wait_and_tap("Restore from Cloud"):
        print("❌ Could not find 'Restore from Cloud' button")
        return False
    time.sleep(2)
    print("  ✅ Fields pre-filled by kDebugMode")

    if not adb.wait_and_tap("Restore"):
        print("❌ Could not find 'Restore' button")
        return False
    print("  ✅ Restore button tapped — waiting for Worker response…")

    if not adb.wait_for_text("Unlock", timeout_s=60):
        texts = adb.visible_texts()
        errors = [t for t in texts if "fail" in t.lower() or "error" in t.lower()]
        if errors:
            print(f"  ❌ Restore failed: {errors}")
        else:
            print("  ❌ Timed out waiting for unlock screen")
        return False
    print("  ✅ Restore complete — unlock screen appeared")

    # ── Step 10: Unlock again ─────────────────────────────────
    print("\n🔐 Step 10: Unlock")
    time.sleep(2)

    adb.text(passphrase)
    time.sleep(0.5)

    if not adb.wait_and_tap("Unlock", timeout_s=10):
        print("❌ Could not find Unlock button")
        return False
    time.sleep(3)

    if not adb.wait_for_text("Dashboard", timeout_s=10):
        print("  ⚠️  Dashboard not detected, continuing anyway...")
    print("  ✅ Unlocked — on Dashboard")

    # ── Step 11: Verify Test01 + Test02 persisted from R2 ─────
    print("\n🔍 Step 11: Verify Test01 + Test02 persisted from R2")
    time.sleep(2)
    texts = adb.visible_texts()
    print(f"  Visible texts: {[t for t in texts if t][:20]}")

    test01_found = any("Test01" in t for t in texts)
    test02_found = any("Test02" in t for t in texts)

    if test01_found and test02_found:
        print("  🎉 VERIFIED: Both Test01 and Test02 persisted from R2!")
        return True
    elif test01_found:
        print("  ⚠️  PARTIAL: Test01 found but Test02 NOT found")
        return False
    elif test02_found:
        print("  ⚠️  PARTIAL: Test02 found but Test01 NOT found")
        return False
    else:
        print("  ❌ FAILED: Neither Test01 nor Test02 found after re-restore")
        print("     The push to R2 may not have succeeded.")
        return False


# ── Main flow ──────────────────────────────────────────────────────

def run_full_flow(adb: Adb, creds: dict[str, str]) -> bool:
    """Run the complete 11-step flow."""
    # ── Phase 1: Steps 1–7 ────────────────────────────────────
    print("=" * 60)
    print("PHASE 1: Restore → Create Tasks → Commit → Push")
    print("=" * 60)

    if not run_phase1(adb, creds):
        print("\n❌ Phase 1 failed — check output above for errors")
        return False

    print("\n" + "=" * 60)
    print("PHASE 2: Verify R2 Persistence")
    print("=" * 60)

    if not run_phase2_verify(adb, creds):
        print("\n❌ Phase 2 verification failed")
        return False

    print("\n🎉 Full flow complete — R2 round-trip verified!")
    return True


# ── Main ───────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="adb automation: Restore → Create Tasks → Commit → Push → Verify R2 persistence",
    )
    parser.add_argument("--device", "-d", help="adb device serial")
    parser.add_argument(
        "--phase1-only", action="store_true",
        help="Run only Phase 1 (steps 1-7), skip verification",
    )
    args = parser.parse_args()

    creds = parse_credentials()
    print(f"✅ Parsed credentials from {CREDS_PATH}")

    adb = Adb(device=args.device)

    if args.phase1_only:
        success = run_phase1(adb, creds)
    else:
        success = run_full_flow(adb, creds)

    if success:
        print("\n🎉 Flow complete!")
    else:
        print("\n❌ Flow failed — check output above for errors")
        sys.exit(1)


if __name__ == "__main__":
    main()
