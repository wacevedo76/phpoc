---
name: phpoc-flutter-emulator-restore
description: Automated Android-emulator workflow for phpoc-flutter — boot the emulator, wipe + clean-build + install a debug APK, read credentials from TEST_CREDENTIALS.md, and drive the Restore-from-Cloud onboarding via adb. Use when asked to run or test phpoc-flutter Restore-from-Cloud on this machine's Android emulator.
---

# phpoc-flutter Emulator Restore-from-Cloud

Boot emulator → wipe app → clean build → install → Restore-from-Cloud, driven with `adb`
(`input tap`/`input text` to act, `uiautomator dump` to read; Flutter text is in `content-desc`).
Secrets come from `TEST_CREDENTIALS.md` (repo root, gitignored) — never hardcode them here.

```bash
export PATH="$PATH:$HOME/Android/Sdk/platform-tools:$HOME/Android/Sdk/emulator"
PKG=com.phpoc.phpoc_flutter
SERIAL=$(adb devices | awk '/emulator-/ && $2=="device"{print $1; exit}')
ADB="adb -s ${SERIAL:-emulator-5554}"
```

## 1. Boot emulator
```bash
flutter emulators --launch pixel_6_avg    # alt: $HOME/Android/Sdk/emulator/emulator -avd pixel_6_avg -no-snapshot-load -no-audio -no-boot-anim &
adb wait-for-device
until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
```

## 2. Clear app
```bash
$ADB uninstall $PKG
```

## 3. Clean build + install
```bash
cd phpoc-flutter && flutter clean && flutter pub get && flutter build apk --debug
$ADB install -r build/app/outputs/flutter-apk/app-debug.apk
```

## 4. Credentials
Read `TEST_CREDENTIALS.md` → "Quick Reference — Test Ledger" table (NOT the dev "Personal Ledger" section). Set:
```bash
SEED=<Recovery Seed>   PASS=<Passphrase>   URL=<Worker URL>   KEY=<Worker API Key>
```

## 5. Drive Restore-from-Cloud
Coords for pixel_6_avg (1080×2400); re-derive from a `uiautomator dump` if layout differs.
```bash
$ADB shell am start -n $PKG/.MainActivity; sleep 8
$ADB shell input tap 540 1495; sleep 3    # Landing: "New Ledger"
$ADB shell input tap 540 1493; sleep 2    # "Restore from Cloud" card
$ADB shell input text "$SEED"             # seed field is autofocused
$ADB shell input tap 540 895;  $ADB shell input text "$PASS"   # Passphrase
$ADB shell input tap 540 1063; $ADB shell input text "$URL"    # Worker URL
$ADB shell input tap 540 1231; $ADB shell input text "$KEY"    # API Key
$ADB shell input keyevent 111             # dismiss IME (else it swallows the next tap)
$ADB shell input tap 540 1399             # Restore
```

## 6. Verify success (poll for the unlock screen)
```bash
for i in $(seq 1 30); do
  $ADB shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  $ADB shell cat /sdcard/ui.xml 2>/dev/null | grep -q "Enter your passphrase" && { echo SUCCESS; break; }
  sleep 4
done
```

## Notes
- `input text` passes `+ / = : .` literally (verified). Test-ledger creds contain no spaces.
- Field order top→bottom: seed → passphrase → URL → API key; seed is autofocused on open.
- Read UI: `$ADB shell uiautomator dump /sdcard/ui.xml && $ADB shell cat /sdcard/ui.xml`.
