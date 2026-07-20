# Flutter Mobile Architecture

> **Date:** 2026-07-17
> **Branch:** `feature/flutter-mobile`
> **Context:** Flutter app is a UI port of the web screens, reusing the Rust crypto core
> (`phpoc-crypto-core/`) via `flutter_rust_bridge`. Architecture informed by a comparative
> analysis of the CLI (Python, 4-layer) and web (React, context-based) architectures.

---

## Table of Contents

1. [Comparative Analysis: Web vs CLI](#1-comparative-analysis)
2. [What Works — Patterns to Carry Forward](#2-what-works)
3. [What Doesn't Work — Anti-Patterns to Avoid](#3-what-doesnt-work)
4. [Flutter Architecture](#4-flutter-architecture)
5. [Project Structure](#5-project-structure)
6. [State Management](#6-state-management)
7. [Navigation & Routing](#7-navigation--routing)
8. [Data Layer](#8-data-layer)
9. [Screen Inventory](#9-screen-inventory)
10. [flutter_rust_bridge Integration](#10-flutter_rust_bridge-integration)
11. [Platform-Specific Considerations](#11-platform-considerations)

---

## 1. Comparative Analysis

### CLI Architecture (Python — reference implementation)

```
cli/          ← Commands, display, onboarding, daemon
core/         ← Factory, sync orchestrator, transports
domain/       ← Ledger engine, staging service, merge, cookies
storage/      ← Abstract interfaces + file-based implementations
security/     ← Crypto, auth, device identity, recovery
```

**Key characteristics:**
- 4-layer dependency hierarchy (cli → core → domain → storage/security)
- Factory pattern for initialization (`LedgerFactory`)
- Abstract interfaces for storage and transport (Dependency Inversion)
- Sync orchestration is coordinated, not owned-by-domain
- Zero external dependencies at the core
- CLI is the primary consumer; daemon for background work

### Web Architecture (React — first UI client)

```
phpoc-web/src/
├── App.jsx              ← Phase-based lifecycle, error boundary
├── context/
│   └── DevModeContext.jsx  ← 1400+ line "god context": services, auth, onboarding, sync
├── components/
│   ├── screens/         ← 10 screens (Dashboard, History, Sync, Settings, etc.)
│   ├── modals/          ← PassphraseModal
│   ├── overlays/        ← ReauthOverlay
│   ├── layout/          ← AppLayout (nav bar)
│   └── sync/            ← SyncIndicator
├── sync/                ← SyncService, RemoteSync, LocalCache, MergeEngine, GenesisGate
├── ledger/              ← Chain, Engine, Index, Summary, Merge — JS ports of Python
├── crypto/              ← CryptoService wrapping WASM (phpoc-crypto-core)
├── hooks/               ← useAutoSync, useCookieMonitor
└── services/            ← Import/export, data seeding
```

**Key characteristics:**
- Phase-based lifecycle: boot → landing → onboarding → auth → ready
- Single giant context (`DevModeContext`) — services, state, and actions in one place
- SyncService as unified entry point for local CRUD + remote sync
- Crypto bridged to Rust WASM — same binary as mobile will use
- IndexedDB for persistent storage
- React hooks for derived state (auto-sync, cookie monitoring)
- No proper routing — screen state is a `useState('dashboard')` switch

---

## 2. What Works — Patterns to Carry Forward

### From the CLI

| Pattern | Why it works | Flutter equivalent |
|---------|-------------|-------------------|
| **Layered architecture** (cli → core → domain → storage) | Clear dependency direction. Test each layer independently. | Feature-first with shared data/core layers |
| **Factory pattern** for initialization | One place to wire dependencies. Easy to swap implementations. | Dependency injection via Riverpod providers |
| **Abstract interfaces** for storage/transport | Test with in-memory backends, run with real ones. | Dart interfaces (`abstract class`) + `implements` |
| **Sync orchestration is separate from domain** | Domain owns the data model. Orchestration owns the workflow. | `SyncOrchestrator` service class |
| **Zero-dependency core** | The engine is pure Dart, no Flutter imports. Testable without emulator. | `lib/core/` — pure Dart, no `package:flutter` |

### From the Web

| Pattern | Why it works | Flutter equivalent |
|---------|-------------|-------------------|
| **Phase-based lifecycle** | Clear state machine for app boot. No ambiguous intermediate states. | `AppLifecycle` enum + Riverpod `StateNotifier` |
| **SyncService as single entry point** | All staging ops go through one class. Consistent auth gating. | `SyncService` class, same API surface |
| **Rust crypto via FFI** | Crypto is written once, verified once, used everywhere. | `flutter_rust_bridge` auto-generated Dart bindings |
| **Device cookie for auth gating** | No session tokens. The cookie is the auth truth. | Same logic, implemented in Dart |
| **Debounced auto-sync** | Writes trigger push after a delay. Resilient to errors. | `Timer`-based debounce in SyncService |
| **Cookie TTL monitoring** | Periodic check prevents stale sessions. | `Timer.periodic` in a service |
| **Genesis gate before sync** | Fast SHA-256 check before full chain pull. | Identical algorithm in Dart |

---

## 3. What Doesn't Work — Anti-Patterns to Avoid

### From the Web

| Anti-pattern | Problem | Flutter fix |
|-------------|---------|------------|
| **1400-line god context** (`DevModeContext.jsx`) | Unmaintainable. Every feature touches one file. | Split into focused Riverpod providers |
| **Services created inline** | `createStorage()`, `createAutoSync()`, etc. inside context. Hard to test. | Dependency injection at app root |
| **Hook ordering constraints** | React requires hooks at top level before conditionals. Forces awkward patterns. | Flutter has no such constraint |
| **Switch-based navigation** | `switch(currentScreen)` with no history, no deep linking, no back stack. | `go_router` with proper navigation stack |
| **IndexedDB complexity** | Schema-less, manual key management, async API with edge cases. | SQLite via `sqflite` / `drift` — typed, relational, battle-tested |
| **No offline-first architecture** | Web assumes connectivity. Mobile must work offline. | Local SQLite as source of truth, sync as background process |
| **All state in one context** | Changing `currentScreen` or `phase` triggers re-render of entire tree. | Riverpod's `select()` for granular rebuilds |
| **Inline crypto fallback logic** | 6 try/catch blocks for WASM fallback. Removed after 168 LOC cleanup. | No fallback needed — Rust `.so` is always available on mobile |

### From the CLI

| Anti-pattern | Problem | Flutter fix |
|-------------|---------|------------|
| **CLI-specific patterns** (argparse, print, exit) | Not applicable to a GUI. | N/A — these are CLI-only |
| **File-based storage** (`~/.local/share/phpoc/`) | Mobile has sandboxed app directories. | SQLite in app documents directory |

---

## 4. Flutter Architecture

### Overview

```
┌─────────────────────────────────────────────────┐
│  Presentation Layer (UI)                         │
│  screens/ + widgets/ + routes/                   │
│  State: Riverpod providers                       │
├─────────────────────────────────────────────────┤
│  Application Layer                               │
│  services/ — SyncService, AuthService            │
│  Coordinates data layer + UI state               │
├─────────────────────────────────────────────────┤
│  Data Layer                                      │
│  sync/ — staging, remote, merge, genesis gate    │
│  ledger/ — chain, engine, index, summary         │
│  storage/ — SQLite, preferences                  │
├─────────────────────────────────────────────────┤
│  Domain Layer (pure Dart, no Flutter imports)    │
│  models/ — Entry, Block, Cookie, Identity        │
│  crypto/ — Dart wrapper around Rust FFI          │
├─────────────────────────────────────────────────┤
│  Native Layer                                    │
│  phpoc-crypto-core (Rust → .so)                  │
│  flutter_rust_bridge (auto-generated bindings)    │
│  Platform: Keychain (iOS), EncryptedSharedPrefs  │
└─────────────────────────────────────────────────┘
```

### Dependency direction

```
Presentation → Application → Data → Domain → Native (Rust)
```

Each layer only depends on the layer directly below it. The Domain layer has no Flutter imports — it's pure Dart, testable on any Dart runtime.

---

## 5. Project Structure

```
phpoc-flutter/lib/
├── main.dart                     ← App entry point, provider scope
├── app.dart                      ← MaterialApp, theme, router
│
├── core/                         ← Pure Dart, NO Flutter imports
│   ├── models/                   ← Data classes (immutable, equatable)
│   │   ├── entry.dart
│   │   ├── block.dart
│   │   ├── device_cookie.dart
│   │   ├── identity.dart
│   │   └── sync_result.dart
│   ├── crypto/                   ← Dart wrapper around Rust FFI
│   │   └── crypto_service.dart
│   └── utils/                    ← Pure helpers (base64, JSON sort, etc.)
│       ├── base64.dart
│       └── json_utils.dart
│
├── data/                         ← Data layer
│   ├── storage/                  ← Local persistence
│   │   ├── database.dart         ← SQLite schema + migrations
│   │   ├── entry_dao.dart
│   │   ├── block_dao.dart
│   │   └── preferences.dart      ← Key-value (SharedPreferences / NSUserDefaults)
│   ├── sync/                     ← Port of web `src/sync/`
│   │   ├── sync_service.dart     ← Unified entry point (port of sync.js)
│   │   ├── remote_sync.dart      ← Blob pull/push with obfuscation
│   │   ├── local_cache.dart      ← Staging CRUD
│   │   ├── merge_engine.dart     ← Cross-device dedup
│   │   ├── genesis_gate.dart     ← Genesis compatibility check
│   │   ├── hash_index.dart       ← SHA-256 fast path
│   │   ├── device_cookie.dart    ← Cookie create/validate
│   │   └── transport.dart        ← HTTP transport (port of HttpTransport)
│   ├── ledger/                   ← Port of web `src/ledger/`
│   │   ├── chain.dart
│   │   ├── engine.dart
│   │   ├── index_manager.dart
│   │   └── summary_policy.dart
│   └── repositories/             ← Facades over DAOs + sync
│       ├── entry_repository.dart
│       └── ledger_repository.dart
│
├── services/                     ← Application layer (business logic + state)
│   ├── auth_service.dart         ← Passphrase, PBKDF2, MK derivation
│   ├── sync_orchestrator.dart    ← Sync lifecycle coordination
│   └── onboarding_service.dart   ← Genesis creation, import, worker connect
│
├── features/                     ← Presentation (screens + their providers)
│   ├── onboarding/
│   │   ├── onboarding_screen.dart
│   │   └── providers/            ← Feature-scoped Riverpod providers
│   ├── auth/
│   │   ├── unlock_screen.dart
│   │   └── providers/
│   ├── dashboard/
│   │   ├── dashboard_screen.dart
│   │   └── providers/
│   ├── history/
│   │   ├── history_screen.dart
│   │   └── providers/
│   ├── sync/
│   │   ├── sync_screen.dart
│   │   └── providers/
│   ├── settings/
│   │   ├── settings_screen.dart
│   │   └── providers/
│   └── shared/                   ← Shared widgets
│       ├── app_scaffold.dart     ← Bottom nav, app bar
│       ├── loading_indicator.dart
│       ├── error_banner.dart
│       └── passphrase_dialog.dart
│
├── routing/
│   └── app_router.dart           ← go_router configuration
│
└── theme/
    └── app_theme.dart            ← ThemeData, colors, typography
```

---

## 6. State Management

### Choice: Riverpod

Riverpod is chosen over Bloc, Provider, or vanilla `setState` for these reasons:

| Criterion | Riverpod | Bloc | Provider |
|-----------|----------|------|----------|
| Compile-time safety | ✅ Provider names are checked | ⚠️ String-based events | ❌ Runtime `context.read` errors |
| Testability | ✅ Override any provider in test | ✅ | ⚠️ Requires widget tree |
| Granular rebuilds | ✅ `select()` | ⚠️ `BlocBuilder` per bloc | ❌ Rebuilds all `Consumer`s |
| No BuildContext needed | ✅ `ref.read()` anywhere | ⚠️ Needs context | ❌ Needs context |
| Code generation support | ✅ `@riverpod` annotation | ❌ | ❌ |
| Async built-in | ✅ `AsyncNotifier` | ⚠️ Manual | ❌ |

### Provider Architecture

```dart
// ── App lifecycle state ──────────────────────────────────────────
enum AppPhase { boot, landing, onboarding, auth, ready }

@riverpod
class AppLifecycle extends _$AppLifecycle {
  AppPhase build() => AppPhase.boot;

  Future<void> initialize() async { /* probe storage, check existing data */ }
  void goToAuth() => state = AppPhase.auth;
  void goToReady() => state = AppPhase.ready;
}

// ── Services (singletons, initialized after boot) ─────────────────
@riverpod
CryptoService cryptoService(Ref ref) => CryptoService();

@riverpod
AppDatabase database(Ref ref) => AppDatabase();

@riverpod
SyncService syncService(Ref ref) {
  return SyncService(
    storage: ref.watch(databaseProvider),
    crypto: ref.watch(cryptoServiceProvider),
    transport: ref.watch(transportProvider),
  );
}

// ── Feature-scoped providers ──────────────────────────────────────
@riverpod
class ActiveTask extends _$ActiveTask {
  Future<Entry?> build() async {
    final sync = ref.watch(syncServiceProvider);
    return sync.getActiveTask();
  }
}

@riverpod
class EntryList extends _$EntryList {
  Future<List<Entry>> build({DateTime? from, DateTime? to}) async {
    final sync = ref.watch(syncServiceProvider);
    return sync.getEntries(from: from, to: to);
  }
}
```

### What stays out of Riverpod

- **Navigation state** — owned by `go_router` (URL-based, deep-linkable)
- **Form state** — local `StatefulWidget` state (passphrase input, settings fields)
- **Animation state** — local `AnimationController`
- **Focus state** — `FocusNode`

---

## 7. Navigation & Routing

### go_router — declarative, URL-based, deep-linkable ✅ ADR-027

```dart
final appRouter = GoRouter(
  initialLocation: '/',
  redirect: (context, state) {
    final phase = ref.read(appLifecycleProvider);
    if (phase == AppPhase.boot) return '/loading';
    if (phase == AppPhase.landing) return '/landing';
    if (phase == AppPhase.auth) return '/unlock';
    if (phase == AppPhase.ready && state.matchedLocation == '/unlock') return '/';
    return null;
  },
  routes: [
    GoRoute(path: '/loading',       builder: (_, __) => const LoadingScreen()),
    GoRoute(path: '/landing',       builder: (_, __) => const LandingScreen()),
    GoRoute(path: '/onboarding',    builder: (_, __) => const OnboardingScreen()),
    GoRoute(path: '/unlock',        builder: (_, __) => const UnlockScreen()),
    ShellRoute(
      builder: (_, __, child) => AppScaffold(child: child),
      routes: [
        GoRoute(path: '/',              builder: (_, __) => const DashboardScreen()),
        GoRoute(path: '/history',       builder: (_, __) => const HistoryScreen()),
        GoRoute(path: '/sync',          builder: (_, __) => const SyncScreen()),
        GoRoute(path: '/settings',      builder: (_, __) => const SettingsScreen()),
      ],
    ),
  ],
);
```

### Why this is better than the web's switch statement

| Web (`App.jsx`) | Flutter (`go_router`) |
|-----------------|----------------------|
| `switch(currentScreen)` — no history | Navigation stack with back button |
| No deep linking | URL-based — shareable routes |
| Screen state in React state | Routing state in URL |
| Transition handled manually | Built-in page transitions |

---

## 8. Data Layer

### Storage: SQLite (not IndexedDB)

Mobile has proper SQLite, which is superior to IndexedDB in every way:

| Concern | IndexedDB (Web) | SQLite (Mobile) |
|---------|----------------|-----------------|
| Schema | Schema-less (manual migration) | Typed, versioned migrations |
| Queries | Key-value only | Full SQL (filter, sort, join) |
| Performance | Object store iteration | Indexed queries, B-tree |
| Tooling | Browser DevTools | `drift` inspector, `sqlite3` CLI |
| Reliability | Browser-specific quirks | Battle-tested, ACID |

**Dart package:** `drift` (type-safe ORM with compile-time query validation)

```dart
// Schema
class Entries extends Table {
  TextColumn get entryId => text().named('entry_id')();
  TextColumn get title => text()();
  IntColumn get startEpoch => integer()();
  IntColumn get endEpoch => integer().nullable()();
  BoolColumn get isActive => boolean()();
  BoolColumn get committed => boolean()();
  TextColumn get tags => text().nullable()();       // JSON-encoded list
  TextColumn get pauses => text().nullable()();      // JSON-encoded list
  TextColumn get metadata => text().nullable()();    // Encrypted, base64
  TextColumn get deviceUuid => text()();
  TextColumn get contentHash => text()();

  @override
  Set<Column> get primaryKey => {entryId};
}
```

### Key-Value Storage: SharedPreferences / NSUserDefaults

For small config values (Worker URL, API key, device UUID, cookie):

```dart
// Wrapped in a typed interface
abstract class Preferences {
  String? get workerUrl;
  set workerUrl(String? value);
  String? get apiKey;
  String? get deviceUuid;
  String? get deviceCookie;   // JSON-encoded
  bool get hasExistingData;
}
```

### Transport: HTTP (same as web)

The HTTP transport (`HttpTransport` in JS) ports directly to Dart's `package:http`:

```dart
class HttpTransport {
  final String baseUrl;
  final String apiKey;

  Future<Uint8List?> pull(String path);
  Future<void> push(String path, Uint8List data);
  Future<List<String>> listFiles(String prefix);
  Future<void> delete(String path);
}
```

Identical wire protocol — same Cloudflare Worker, same paths, same ETag semantics.

---

## 9. Screen Inventory

Screens are a direct port of the web UI, adapted for mobile form factor:

| Screen | Web Source | Mobile Adaptations |
|--------|-----------|-------------------|
| **Loading** | `<AppInner>` boot phase spinner | Splash screen with logo |
| **Landing** | `LandingScreen.jsx` | "Log in" + "New ledger" buttons |
| **Onboarding** | `OnboardingScreen.jsx` | Simplified flow: New / Import from file / Connect to Worker |
| **Recovery Seed** | Seed overlay in `App.jsx` | Full-screen with copy + save-to-files option |
| **Unlock** | `AuthScreen.jsx` | Passphrase input with biometric fallback |
| **Dashboard** | `Dashboard.jsx` | Active task card, quick-start form, recent entries |
| **History** | `History.jsx` | Entry list with calendar filter, expand for details |
| **Sync** | `SyncSettings.jsx` | Commit cards, push/pull status, sync now button |
| **Settings** | `Settings.jsx` | Worker config, passphrase change, seed export, about |

### Web screens NOT ported (mobile-specific replacements)

| Web Screen | Why Not Ported | Mobile Replacement |
|-----------|---------------|-------------------|
| `Tags.jsx` | Tag CRUD is inlined in History + Sync | Same — inline editing |
| `LedgerSync.jsx` | Ledger validation is background | Status indicator in Settings |
| `UserProfile.jsx` | Username/email are onboarding-only | Set during onboarding |
| `Configuration.jsx` | Full-page config screen | Folded into Settings |

---

## 10. flutter_rust_bridge Integration

### Architecture

```
phpoc-crypto-core/          (Rust — already built)
├── src/
│   ├── lib.rs              ← Public API: 20 exported functions
│   ├── aes_ctr.rs
│   ├── blob.rs
│   ├── device.rs
│   ├── digest.rs
│   ├── hmac_utils.rs
│   ├── key_derivation.rs
│   └── random.rs
└── tests/
    └── crypto_test_vectors.json

                │ flutter_rust_bridge
                ▼

phpoc-flutter/lib/
└── core/crypto/
    └── crypto_service.dart   ← Thin Dart wrapper around generated bindings
```

### Setup in pubspec.yaml

```yaml
dependencies:
  flutter_rust_bridge: ^2.0.0

flutter_rust_bridge:
  rust_crate_dir: ../phpoc-crypto-core
  rust_output_dir: rust_bridge
```

This auto-generates Dart classes wrapping every public Rust function. The `CryptoService` wrapper adds convenience methods:

```dart
class CryptoService {
  // Generated bindings (auto-completed by flutter_rust_bridge)
  // plus thin convenience layer:

  Future<Uint8List> deriveMasterKey(String passphrase, Uint8List seed, {int iterations = 600000});
  Future<String> encryptField(String plaintext, Uint8List key);
  Future<String> decryptField(String ciphertext, Uint8List key);
  Future<Uint8List> obfuscateBlob(Uint8List data, Uint8List key);
  Future<Uint8List> deobfuscateBlob(Uint8List data, Uint8List key);
  Future<String> computeContentHash(Map<String, dynamic> fields);
  Future<String> randomUuid();
  // ... remaining 14 functions
}
```

### Build targets

| Platform | Rust Target | Output |
|----------|------------|--------|
| Android (arm64) | `aarch64-linux-android` | `libphpoc_crypto_core.so` |
| Android (x86_64) | `x86_64-linux-android` | `libphpoc_crypto_core.so` (emulator) |
| iOS (arm64) | `aarch64-apple-ios` | `libphpoc_crypto_core.a` |
| Linux (x86_64) | `x86_64-unknown-linux-gnu` | `libphpoc_crypto_core.so` (desktop dev) |

The `ring` crate already supports all four targets. No changes to `phpoc-crypto-core` needed.

---

## 11. Platform Considerations

### Biometric Auth

The passphrase is the source of truth. Biometrics unlock a locally-stored encrypted master key — same model as the web's IndexedDB-cached seed.

| Platform | Biometric API | Key Storage |
|----------|--------------|-------------|
| Android | `BiometricPrompt` (BiometricManager) | EncryptedSharedPreferences (AndroidX Security) |
| iOS | `LocalAuthentication` (LAContext) | Keychain (kSecClassGenericPassword) |
| Linux | N/A | File-based (same as CLI) |

Flow:
1. User enters passphrase first time → derive MK → encrypt MK with biometric-bound key → store
2. Subsequent unlocks: biometric → decrypt MK → ready (no passphrase)
3. If biometrics fail (new fingerprint, etc.): fall back to passphrase

### Background Sync

Unlike the web, mobile can sync in the background:

| Platform | Mechanism | Capability |
|----------|----------|------------|
| Android | `WorkManager` | Periodic sync (min 15min interval), network constraints |
| iOS | `BGTaskScheduler` | Opportunistic sync when app is backgrounded |

Background tasks push staging changes and pull remote updates. Heavy crypto (ledger commit) stays foreground-only.

### Secure Storage

| Data | Storage | Reason |
|------|---------|--------|
| Seed (encrypted) | SQLite / encrypted prefs | Needed for MK derivation on login |
| Master Key (unlocked) | In-memory only | Cleared on lock/logout |
| Device UUID | SharedPreferences | Non-sensitive, persistent |
| Device Cookie | SharedPreferences | Non-sensitive, JSON-encoded |
| Worker API Key | EncryptedSharedPrefs (Android) / Keychain (iOS) | Sensitive credential |
| Staging entries | SQLite | Frequent CRUD, needs query |
| Ledger blocks | SQLite | Append-mostly, needs verification |
| Blind index | SQLite | Frequent query by date |

### Offline-First

Mobile must work fully offline. The architecture supports this:

1. **All writes go to local SQLite first** — instant, no network
2. **Sync is background** — debounced push after writes, pull on app resume
3. **No operation requires network** — `checkAndSync()` returns `OFFLINE` gracefully
4. **Conflict resolution is client-side** — merge engine runs locally, push merged result when online

This is the same model as the CLI's WAL (write-ahead log) — local-first, sync-when-available.

---

## Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| State management | Riverpod | Compile-time safe, granular rebuilds, testable, no BuildContext needed |
| Navigation | go_router ✅ ADR-027 | Declarative, URL-based, deep-linkable, back stack |
| Local storage | SQLite (drift) | Typed, indexed, ACID — superior to IndexedDB |
| Crypto | flutter_rust_bridge → phpoc-crypto-core | Same Rust binary as web. One implementation, zero drift |
| Architecture | Feature-first with shared data/core layers | Clear dependency direction, testable in isolation |
| Offline | Local-first, sync-when-available | Same model as CLI WAL. Works without network |
| Biometrics | Opt-in convenience, passphrase is truth | Same model as web's cached MK |
| Background sync | WorkManager (Android) / BGTaskScheduler (iOS) | Push staging changes when app is backgrounded |
