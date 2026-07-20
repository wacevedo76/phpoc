# Google Play Store — Release Checklist

> **Date:** 2026-07-17
> **Context:** PH Ledger Flutter mobile app — pre-release planning for Google Play submission.
> 64 files committed to `feature/flutter-mobile-riverpod`, all screens are stubs, no production
> features built yet. This doc is the living checklist; check off items as they're completed.

---

## 1. Device Testing (Pre-Play Store)

Physical device testing catches issues emulators miss: gesture timing, keyboard interaction,
biometric auth, thermal throttling, real networking, and Play Services quirks.

| Tier | Method | Cost | Fidelity | Status |
|------|--------|------|----------|--------|
| **Emulator** | `flutter emulators --launch pixel_6_avg` | Free | 80% | ✅ Available |
| **Physical USB** | `flutter run -d <device-id>` | $0 | 95% | 🔜 |
| **Release APK sideload** | `flutter build apk --release && flutter install` | $0 | 100% perf | 🔜 |
| **Internal track** | Play Console → private link | $25 | 100% signed | 🔜 |
| **Test Lab** | Firebase Test Lab (device matrix) | Free tier | 100% × 20 devices | 🔮 |

### Physical USB Testing — Setup

```bash
# 1. On Android phone: Settings → About Phone → tap Build Number 7×
# 2. Settings → Developer Options → enable USB Debugging
# 3. Plug phone into dev machine, accept host key on phone
adb devices                          # verify device shows as "device" (not "unauthorized")

# Debug build (hot-reload, JIT-compiled — good for dev iteration)
flutter run -d <device-id>

# Release build (AOT-compiled, stripped — test real performance)
flutter build apk --release
flutter install -d <device-id>
```

### What to Test on Real Hardware

- [ ] Passphrase entry (keyboard behavior, input method quirks)
- [ ] Biometric auth (fingerprint / face unlock) — emulator can't do this
- [ ] Network transitions (WiFi → cellular → offline) during sync
- [ ] Background → foreground lifecycle (app suspended during active task)
- [ ] Notification tap behavior (if notifications are added)
- [ ] Low-storage edge cases (SQLite writes when disk is near full)
- [ ] Android 14+ "taskbar" / foldable / multi-window behavior
- [ ] Dark mode / system font size changes at runtime

---

## 2. Play Store Publishing Requirements

### 2.1 One-Time Prerequisites

| # | Item | Cost / Effort | Status |
|---|------|---------------|--------|
| 1 | **Google Play Console account** | $25 USD one-time | 🔜 |
| 2 | **Developer name** (public-facing) | Decide | 🔜 |
| 3 | **Privacy policy URL** | Host a page (GitHub Pages, Worker, etc.) | 🔜 |
| 4 | **Terms of service URL** (optional but recommended) | Host a page | 🔮 |
| 5 | **App content rating** (IARC questionnaire) | ~10 min in Play Console | 🔜 |
| 6 | **Data safety section** | Declare in Play Console | 🔜 |

### 2.2 Build Requirements

| # | Item | PH Ledger Status | Notes |
|---|------|-----------------|-------|
| 1 | **Target API ≥ 34** | ✅ Targets 35 | Required for new apps |
| 2 | **App Bundle (AAB)** | 🔜 `flutter build appbundle` | APKs rejected for new apps |
| 3 | **64-bit native code** | ✅ ARM64 via Flutter | `ring` / Rust .so must compile for ARM64 |
| 4 | **App signing** | 🔜 Setup needed | Play App Signing (Google manages release key) |
| 5 | **Debug symbols** | 🔮 | Upload native debug symbols for crash reporting |
| 6 | **R8 / ProGuard** | 🔜 Configure | Android minification — default Flutter config may need review |

### 2.3 App Signing Setup

Two keys to manage:

| Key | Who holds it | Purpose |
|-----|-------------|---------|
| **Upload key** | You (keystore file) | Sign the AAB before upload |
| **App signing key** | Google Play | Re-signs the APK delivered to users |

```bash
# Generate upload keystore (do this once, secure it well)
keytool -genkey -v -keystore ~/.android/phpoc-upload.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias phpoc-upload

# Reference in android/key.properties (gitignored — never commit)
# storePassword=<password>
# keyPassword=<password>
# keyAlias=phpoc-upload
# storeFile=/home/wacevedo/.android/phpoc-upload.jks

# Build signed AAB
flutter build appbundle --release
```

> ⚠️ **Critical**: If you lose the upload key and use Play App Signing, Google can issue a
> replacement. If you lose a self-managed signing key, the app is permanently unpublishable
> and must be re-uploaded under a new package name. Play App Signing is the safer default.

### 2.4 Rust Crypto Cross-Compilation

The `phpoc-crypto-core` Rust crate (`ring` + custom AES/HMAC/PBKDF2) must compile for Android NDK targets:

| Target | Required | Status |
|--------|----------|--------|
| `aarch64-linux-android` | Yes (ARM64) | 🔜 |
| `armv7-linux-androideabi` | Yes (ARM32) | 🔜 |
| `x86_64-linux-android` | Yes (emulator) | 🔜 |
| `i686-linux-android` | Optional (legacy emulator) | 🔮 |

`flutter_rust_bridge` handles NDK integration and `.so` bundling into the AAB.

---

## 3. Content & Policy Requirements

### 3.1 Encryption Export (U.S. BIS EAR)

- **Classification**: Mass market encryption — PH Ledger uses standard crypto (AES-256-GCM,
  HMAC-SHA256, PBKDF2) for end-user data protection, not as a product feature.
- **CCATS filing**: Not required for mass-market encryption products.
- **Play Console**: Check the box confirming the app uses standard cryptography.
- **EAR notification**: Self-classify as 5A002.c.1 → mass market (no reporting required per
  §740.17(b)(1) supplement 6, Note 3 exemption).

### 3.2 Data Safety Section (Play Console)

PH Ledger's data story is an advantage: **all data is encrypted at rest, and sync is to the
user's own infrastructure, not a centralized server.**

| Data type | Collected? | Shared? | Encrypted? | Deletable? |
|-----------|-----------|---------|------------|------------|
| Personal info (passphrase hash) | On-device only | No | Yes (PBKDF2 + AES) | Yes (clear app data) |
| User activity data (entries) | On-device only | No* | Yes (AES-256-GCM) | Yes (clear app data) |
| Device identifier | On-device only | No* | N/A | Yes (clear app data) |
| Sync endpoint URL | On-device only | No* | At rest (if stored) | Yes (clear app data) |
| Crash logs (optional) | With consent | Only with developer | N/A | N/A |

> *Sync destination is the user's own Cloudflare Worker — the developer has no access to
> the data in transit or at rest. This is not "data sharing" in the Play Store sense.

### 3.3 Permissions

| Permission | Needed? | Why |
|------------|---------|-----|
| `INTERNET` | Yes | Sync to Worker |
| `USE_BIOMETRIC` | Optional | Fingerprint/face unlock |
| `MANAGE_EXTERNAL_STORAGE` | No | Data stays in app-private storage |
| `FOREGROUND_SERVICE` | No* | Sync is manual or on-foreground only |
| `ACCESS_BACKGROUND_LOCATION` | No | No location tracking |

> *If background sync is added later, a foreground service type must be declared in the
> manifest and the feature must be justified in Play Console review.

---

## 4. Store Listing Assets

Required for production release:

| Asset | Spec | Status |
|-------|------|--------|
| **App icon** | 512×512 PNG, adaptive icon (Android 8+) | 🔜 |
| **Feature graphic** | 1024×500 PNG | 🔜 |
| **Screenshots** | Min 2, max 8 per device type. Phone + 7-inch tablet + 10-inch tablet required | 🔜 |
| **Short description** | 80 characters max | 🔜 |
| **Full description** | 4000 characters max | 🔜 |
| **App category** | Productivity (or Tools) | 🔜 |
| **Tags** | Time tracking, encryption, privacy, journal | 🔜 |

---

## 5. Testing Tracks (Staged Rollout)

| Track | Audience | Purpose | Status |
|-------|----------|---------|--------|
| **Internal** | Up to 100 email lists | Dev team, earliest builds | 🔜 |
| **Closed (Alpha)** | Invite-only via email/Google Group | Trusted testers, feedback | 🔜 |
| **Open (Beta)** | Unlimited, opt-in via Play Store | Public beta | 🔮 |
| **Production** | Everyone | Full release | 🔮 |

Internal track is available immediately after the first AAB upload — no content rating or
store listing needed. Closed track requires a completed store listing. Production requires
all policies met.

---

## 6. Practical Sequence

### Phase A: Dev Testing (can start today)
1. [ ] Test on physical phone via USB (`flutter run`)
2. [ ] Test release APK (`flutter build apk --release && flutter install`)

### Phase B: Infrastructure (one-time, ~$25 + a few hours)
1. [ ] Create Google Play Console account
2. [ ] Generate upload keystore
3. [ ] Configure Play App Signing
4. [ ] Create privacy policy page (host on Worker or GitHub Pages)

### Phase C: First Internal Upload (~2 hours)
1. [ ] `flutter build appbundle --release`
2. [ ] Upload AAB to Internal track
3. [ ] Add testers' emails
4. [ ] Testers install via private Play Store link

### Phase D: Production Release (when app is feature-complete)
1. [ ] Complete store listing (descriptions, screenshots, icon)
2. [ ] Complete IARC content rating questionnaire
3. [ ] Complete Data safety section
4. [ ] Submit for review (typically 1–3 days)

---

## 7. Crypto Core — Android Build Requirements

Tracked separately in `phpoc-crypto-core/AGENTS.md`. Key integration points:

- **NDK**: Installed as part of Android SDK setup (`sdkmanager "ndk;27.0.12077973"`)
- **Rust targets**: `rustup target add aarch64-linux-android armv7-linux-androideabi`
- **`ring` crate**: Requires `ANDROID_NDK_HOME` set and compiler toolchain for each target
- **FFI bridge**: `flutter_rust_bridge` generates Dart bindings and CMake/gradle config
- **Build**: `flutter_rust_bridge_codegen generate` → `flutter build appbundle`

---

## References

- [Google Play Console Help](https://support.google.com/googleplay/android-developer)
- [Android App Bundle docs](https://developer.android.com/guide/app-bundle)
- [Play App Signing](https://developer.android.com/studio/publish/app-signing#play-app-signing)
- [Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Target API level policy](https://support.google.com/googleplay/android-developer/answer/11926878)
- [BIS EAR encryption](https://www.bis.doc.gov/index.php/policy-guidance/encryption)
- [`flutter_rust_bridge` — Android setup](https://cjycode.com/flutter_rust_bridge/guides/setup/android)
