# PH Ledger — React Web UI Design Decisions

> **Date:** 2026-06-08
> **Context:** Phase 1 (Web Prototype) of the cross-platform rollout. CLI reference implementation is complete at 1341 tests. The React web UI is the first graphical client, proving the interaction model before the Flutter mobile port.
>
> **Deployment vision:** One codebase supporting four deployment targets — standalone PWA, self-hosted LAN, Docker/LXC, and multi-tenant SaaS. The `StoragePlugin` interface is the linchpin that makes this possible.

---

## 1. Screen Architecture

### 1.1 Screen Components

Each screen is a standalone React component in `src/components/screens/`. Screens are **not** route-addressable via React Router — they use a simple state-based navigation (`currentScreen` in `App.jsx`) driven by a bottom tab bar. This avoids URL complexity for a PWA that is primarily a single-page app, and keeps the Flutter port's navigation model (also tab-based) consistent.

| Screen | Component File | CLI Origin | Purpose |
|--------|---------------|------------|---------|
| AuthScreen | `AuthScreen.jsx` | `ph login` | Passphrase entry → PBKDF2 → seed decryption |
| Dashboard | `Dashboard.jsx` | `ph view` + `ph add` | Main screen: active tasks + new task form (timed / one-off toggle) |
| NewTask | `NewTask.jsx` | `ph add` | Standalone task creation (alternative entry) |
| History | `History.jsx` | `ph list` | Completed entries, grouped by day, filtered |
| Tags | `Tags.jsx` | `ph tags` | Tag list with frequency counts |
| SyncSettings | `SyncSettings.jsx` | `ph sync` | Sync screen — uncommitted entry pills, selection + commit bar, NOT_SYNCED when staging has entries, sync status |
| UserProfile | `UserProfile.jsx` | `ph login info` | Identity card, auth status, stats, gateway to config |
| Configuration | `Configuration.jsx` | `ph config` / CLI config file | All 27 CLI config fields across 9 sections |
| LedgerSync | `LedgerSync.jsx` | `ph sync --commit` | Phase 3 placeholder for block chain commit |
| Settings | `Settings.jsx` | `ph settings` | Dev mode, remote sync config, ledger export/import, about |

### 1.2 Sub-Navigation: Profile → Configuration

Configuration is a **sub-screen**, not a top-level tab. It lives within the Profile tab's view state:

```
Bottom tab: [Home] [Hx] [New] [Tags] [Profile] [Sync] [Settings]
                                              │
                                        UserProfile
                                              │
                                   [Open Configuration]
                                              │
                                              ▼
                                        Configuration
                                              │
                                        [← Back]
                                              │
                                              ▼
                                        UserProfile
```

This is managed via a `profileSubview` state variable (`'profile'` | `'configuration'`) in `App.jsx`. Switching away from the Profile tab resets the subview to `'profile'`.

**Rationale:** Configuration is tightly coupled to the user's profile (device identity, authentication, user-specific settings). Making it a sub-screen rather than a separate tab reduces navigation complexity and groups related functionality.

---

## 2. Development Mode & Auth Bypass

### 2.1 The Problem

During UI development, we need:
- No WASM loading (avoids build complexity during visual iteration)
- No passphrase prompt (slows down every page reload)
- Pre-seeded data to test against (empty state is useless for UI work)

### 2.2 Solution: DevModeContext + DummyLedger

```
<DevModeProvider defaultDevMode={true}>
  │
  ├─ DEV MODE (default):
  │   ├─ DummyCryptoService — all 20 WASM functions, deterministic output
  │   │   ├─ generateUuid()  → sequential UUIDs (00000000-...-000100000000)
  │   │   ├─ sha256()        → djb2 hash (no WASM, no Web Crypto)
  │   │   ├─ getMasterKey()  → hardcoded `deadbeef...` dummy key
  │   │   └─ encrypt/decrypt → base64 passthrough with `dummy_enc:` prefix
  │   ├─ DummySyncService — wraps MemoryBackend with 4 seeded entries
  │   │   ├─ "Coding Practice"  → active, running ~25 min
  │   │   ├─ "Reading"          → active, paused ~15 min ago
  │   │   ├─ "Morning Exercise" → completed (earlier today)
  │   │   └─ "Project Planning" → completed (yesterday)
  │   ├─ AuthScreen → auto-authenticates in 300ms
  │   └─ "DEV MODE" indicator on Dashboard
  │
  └─ PRODUCTION MODE (future):
      ├─ Real CryptoService → loads WASM via wasm-bindgen
      ├─ Auth → PBKDF2-600K → decrypt seed → derive master key
      ├─ SyncService → real IndexedDB + HttpTransport
      └─ Toggle via Settings or ?dev=true/false URL param
```

### 2.3 Key Design Points

1. **Same interface, different implementation.** `DummyCryptoService` implements every method that `CryptoService` does. `DummySyncService` implements the same public API as `SyncService`. No screen component ever knows which backend it's talking to — it accesses services via `useApp().services.crypto` and `useApp().services.sync`.

2. **No `Buffer` dependency.** The DummyCryptoService uses `btoa()`/`atob()` (browser native) with `TextEncoder`/`TextDecoder` fallbacks, avoiding Node.js-only `Buffer` imports that would break in the browser.

3. **Deterministic output.** UUIDs are sequential, hashes are djb2-based, master key is hardcoded. This means the same data appears on every page reload, making visual testing predictable.

4. **Auth is a no-op in dev mode.** `AuthScreen` detects `isDev` via context and auto-transitions after 300ms (briefly showing the branding splash). No passphrase is ever collected in dev mode.

5. **Toggle persists.** The dev mode choice is saved to `localStorage('phpoc_dev_mode')` so it survives page refreshes. Can also be overridden via URL parameter `?dev=false`.

6. **Switching to production** means: remove `DevModeProvider` from `App.jsx`, call real `CryptoService.create()`, and the existing AuthScreen naturally prompts for passphrase. Zero changes needed in any screen component.

---

## 3. Dashboard Layout

### 3.1 Portrait / Landscape

The Dashboard is the main screen and uses CSS media queries for layout switching:

| Orientation | Active Tasks | New Task Form |
|-------------|-------------|---------------|
| **Portrait** (default, mobile-first) | Top half | Bottom half |
| **Landscape** (or ≥768px wide) | Left side | Right side |

```css
/* Portrait (default) */
.dashboard { flex-direction: column; }

/* Landscape / tablet */
@media (orientation: landscape) and (max-height: 500px),
       (min-width: 768px) {
  .dashboard { flex-direction: row; }
}
```

### 3.2 ActiveTasksPill Component

Each active task is rendered as an `ActiveTaskPill` — a pill-shaped button card:

```
┌──────────────────────────────────────┐
│  Coding Practice              PAUSED │  ← Top half: title + optional PAUSED badge
│  25:00                               │  ← Monospace elapsed timer
│  #coding #practice                   │  ← Tags (max 2 shown, "+N" overflow)
├──────────────────────────────────────┤
│        ⏸️ (pause)       ⏹️ (stop)    │  ← Bottom half: pause/play | stop
└──────────────────────────────────────┘
```

- **Running tasks** → green left border (`border-left: 3px solid var(--accent-green)`)
- **Paused tasks** → yellow left border, reduced opacity, ▶ icon instead of ⏸
- **Stop** always available regardless of pause state
- **Elapsed timer** updates every second via the `useActiveTasks` hook
- **Paused timer** freezes at the pause-start time (does not tick)

### 3.3 New Task Form

Inline in the Dashboard's bottom/right pane:
- **Title** input (required, auto-focused)
- **Tags** input (comma-separated, optional)
- **▶ Start** button (disabled when title is empty)
- Status message shown briefly on start

A standalone `NewTask` screen is also available from the tab nav, with additional **Comment** field for longer notes.

---

## 4. Navigation

### 4.1 Bottom Tab Bar

7 tabs across the bottom, each with icon + label:

| Tab | Icon | Screen |
|-----|------|--------|
| Home | 🏠 | Dashboard |
| History | 📋 | History |
| New | ➕ | NewTask |
| Tags | 🏷️ | Tags |
| Profile | 👤 | UserProfile |
| Sync | 🔄 | SyncSettings |
| Settings | ⚙️ | Settings |

- Active tab has blue underline indicator
- Tabs are always visible (no scrollable tab bar — fits in 7)
- Navigation is instant (no animation, no routing framework)

### 4.2 Why Not React Router?

The app has 7 top-level screens with no deep linking requirements. A simple `currentScreen` state variable with a switch statement in `renderScreen()` is:
- Simpler to reason about
- One fewer dependency
- Easier to port to Flutter (which uses `BottomNavigationBar` + state, not URL routing)
- Faster iteration (no route config to maintain)

If deep linking becomes necessary (e.g., `ph://ledger/view/2026-06-01`), React Router can be added later without changing the component structure — only the navigation layer changes.

---

## 5. Component Tree

```
<App>
  └─ <DevModeProvider>
      └─ <AppInner>
          ├─ [loading] → <AppLoading />
          ├─ [error]   → <AppError />
          ├─ [!authenticated] → <AuthScreen />
          └─ [authenticated]
              └─ <AppLayout currentScreen onNavigate>
                  ├─ <Dashboard />
                  │   ├─ Active Tasks Pane
                  │   │   └─ <ActiveTaskPill /> × N
                  │   └─ New Task Pane
                  │       └─ form (title + ☐ one-off, tags, Start/Log)
                  ├─ <NewTask />
                  │   └─ form (title, tags, comment, start)
                  ├─ <History />
                  │   ├─ Filter bar (date, tag)
                  │   └─ Day-grouped entry list
                  ├─ <Tags />
                  │   └─ Tag rows with counts
                  ├─ <UserProfile />
                  │   ├─ Identity card (avatar, device label, device UUID)
                  │   ├─ Auth/Key status badges
                  │   ├─ Stats grid (active, completed, tags, tracked time)
                  │   ├─ Device info list
                  │   └─ Configuration gateway card → [Open]
                  ├─ <Configuration />
                  │   └─ 9 collapsible accordion sections
                  │       ├─ Storage (7 path fields)
                  │       ├─ Remote (transport select, git URL)
                  │       ├─ HTTP/Worker (provider, base URL, API key)
                  │       ├─ Auth (timeout range, passphrase toggle)
                  │       ├─ Device (label, read-only ID)
                  │       ├─ Timeouts (2 range sliders)
                  │       ├─ Cookie (TTL range, renewal range, toggle)
                  │       ├─ Debug (trace toggle)
                  │       └─ Staging (blob size tier select)
                  ├─ <SyncSettings />
                  │   ├─ Entry list (compact pills)
                  │   │   ├─ [☐] Stopped entry (yellow, expandable)
                  │   │   │   └─ Inline tag editing (× remove, +input add)
                  │   │   │   └─ Comment textarea (debounced auto-save)
                  │   │   └─ 🔴 Active entry (red, compact, locked)
                  │   ├─ Commit button bar
                  │   │   ├─ Commit Selected (N)
                  │   │   └─ Commit All (N)
                  │   ├─ Status detail rows
                  │   └─ Sync Now button
                  └─ <Settings />
                      ├─ Dev mode toggle
                      ├─ Remote URL + API key
                      ├─ Data Management (Export/Import)
                      │   ├─ Export → PassphraseModal → triggerDownload()
                      │   └─ Import → file picker + seed + passphrase form
                      └─ About section
              └─ Bottom Tab Nav
                  └─ 7 tab buttons
```

---

## 6. Configuration Screen — CLI Config Coverage

The Configuration screen maps exactly to `ConfigManager.DEFAULTS` in `security/config_manager.py`. Every user-configurable field from the CLI is represented:

| Section | Fields | CLI Default | Input Type |
|---------|--------|-------------|------------|
| 💾 Storage | config_dir, data_dir, ledger_file, staging_file, index_file, identity_file, config_file | `~/.config/phpoc`, `~/.local/share/phpoc`, `ledger.json`, etc. | Text (monospace) |
| ☁️ Remote | transport, staging_path, ledger_path, git_remote_url | `http` | Select + Text |
| 🌐 HTTP/Worker | provider, base_url, api_key | `cloudflare` | Select + Text + Password |
| 🔐 Auth | cache_timeout_minutes, passphrase_required | `30`, `true` | Range + Toggle |
| 📱 Device | device_label, device_id | auto-generated | Text + Read-only |
| ⏱️ Timeouts | remote_check_ms, push_timeout_ms | `500`, `5000` | Range |
| 🍪 Cookie | ttl_minutes, cookie_enabled, renewal_threshold | `30`, `true`, `0.9` | Range + Toggle |
| 🐛 Debug | trace_enabled | `false` | Toggle |
| 📦 Staging | blob_size_tier | `64K` | Select |

**27 fields total** across 9 collapsible accordion sections. The Auth section is open by default (the most commonly adjusted settings). All controls are currently **unwired** — they hold local React state but don't persist to any backend. A disclaimer bar at the bottom indicates this.

---

## 7. Key Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| react | ^18.3.1 | UI framework |
| react-dom | ^18.3.1 | DOM rendering |
| react-router-dom | ^6.26.0 | Routing (installed but not yet used — state-based navigation preferred) |
| idb-keyval | ^6.2.5 | IndexedDB wrapper for production storage (already present, used by sync layer) |
| vite | ^5.4.2 | Build tool + dev server |
| @vitejs/plugin-react | ^4.3.1 | React JSX transform for Vite |

---

## 8. Styling Approach

- **Single CSS file** (`App.css`, ~20KB) — no CSS-in-JS, no preprocessor, no CSS modules
- **CSS custom properties** (`--bg-primary`, `--accent-blue`, etc.) for theming
- **Mobile-first** — portrait is the default, landscape/tablet breakpoints via `@media`
- **Dark theme only** — matches the CLI's terminal aesthetic. Light theme is a future consideration.
- **No UI framework** — no Material UI, no Tailwind. Every component is hand-styled for a unique, focused feel suitable for a productivity timer.
- **System font stack** — `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` for native-feeling text rendering
- **Monospace** for times and IDs — `'SF Mono', 'Fira Code', 'Cascadia Code', monospace`

---

## 9. Future Design Considerations

### 9.1 Wired Configuration

When wiring Configuration to real storage, the `DevModeContext` should be extended to include a `config` service (wrapping the CLI's `ConfigManager` interface). The Configuration screen's form submit would call `config.write(mergedFields)` and the provider would re-read on mount.

### 9.2 React Native / Flutter Port

The component structure is designed to map cleanly to Flutter widgets:
- `Screen` → `Scaffold`
- `ActiveTaskPill` → custom `Container` with `Row`/`Column`
- `AppLayout` → `BottomNavigationBar` + `IndexedStack`
- `Dashboard` → `Row` (landscape) / `Column` (portrait) with `Expanded` children
- `Configuration` → `ExpansionTile` list with `Slider`/`Switch`/`DropdownButton`/`TextField`
- `DevModeContext` → `InheritedWidget` + mock services for dev builds

### 9.3 Deep Linking

If the app needs to handle external links or notifications that navigate to specific content (e.g., a specific day's history, a shared proof), React Router can be introduced by wrapping the navigation layer — no component changes needed.

### 9.4 Light Theme

A light theme variant can be added by introducing a `ThemeContext` that swaps CSS custom properties. All colors are already referenced via `var(--color-name)` throughout the CSS.

---

## 10. Temporary Mock Infrastructure (Archivable)

### 10.1 Purpose

The mock infrastructure exists solely to validate and develop the real sync pipeline (`SyncService`, `RemoteSync`, `LocalCache`, `MergeEngine`, `DeviceCookie`) entirely in-browser during Phase 1 prototyping. It avoids needing a running Cloudflare Worker or local bridge server for development.

### 10.2 Components

| Component | File | Purpose | Coupling |
|-----------|------|---------|----------|
| `MockRemoteBackend` | `src/sync/mock_remote.js` | In-browser R2/S3 simulation (IndexedDB-backed, configurable latency, ETag/304/404 simulation, path-prefix listing) | **Zero imports from app code** — standalone class, depends only on `idb-keyval`
| `MockDataSeeder` | `src/services/MockDataSeeder.js` | Generates 14 days of realistic staging entries + device cookie + genesis block + ledger index | Depends only on `DummyCryptoService` (also dev-only)
| `mock_remote_test.mjs` | `test/mock_remote_test.mjs` | 46 tests for MockRemoteBackend | Standalone test file
| `mock_data_seeder_test.mjs` | `test/mock_data_seeder_test.mjs` | 205 tests for MockDataSeeder | Standalone test file
| `DevModeContext` wiring | `src/context/DevModeContext.jsx` | Boot-time seeding + SyncService wiring | Imports from mock/seed files, plus core sync (no reverse coupling)

### 10.3 Dependency Isolation

```
MockRemoteBackend
  └── depends on: idb-keyval (npm package) only
  └── zero dependencies on any app module

MockDataSeeder
  └── depends on: ./DummyLedger.js (also dev-only)

References TO MockRemoteBackend (all removable):
  ├── src/sync/index.js                ← barrel export (delete one line)
  ├── src/context/DevModeContext.jsx    ← dev wiring (delete ~15 lines)
  ├── src/services/MockDataSeeder.js   ← dev seeding service (delete file)
  ├── test/mock_remote_test.mjs        ← its test (delete file)
  └── test/mock_data_seeder_test.mjs   ← seeder test (delete file)

No core file (sync.js, local_cache.js, remote_sync.js, merge_engine.js,
storage.js, transport.js, cookie.js, indexeddb_storage.js) imports from
MockRemoteBackend or MockDataSeeder. Zero reverse coupling.
```

### 10.4 Archive Checklist

When the system is stable and development no longer requires the mock backend:

**Delete (4 files):**
```
phpoc-web/src/sync/mock_remote.js
phpoc-web/src/services/MockDataSeeder.js
phpoc-web/test/mock_remote_test.mjs
phpoc-web/test/mock_data_seeder_test.mjs
```

**Touch (2 files) — remove references:**
1. `src/sync/index.js` — remove `export { MockRemoteBackend }` line
2. `src/context/DevModeContext.jsx` — remove the import lines and the `initializeDevMode` seeding block

**Result:** Zero changes to core sync, transport, storage, or auth code. The production deployment path (`HttpTransport` + real `CryptoService`) is unaffected.

---

## 11. Multi-Deployment Architecture

### 11.1 The Goal

A single phpoc-web codebase that deploys to four targets with zero code changes between them:

| Deployment | Use Case | Storage Backend | Auth | Multi-user |
|---|---|---|---|---|
| **Standalone PWA** | Single user, no server needed | IndexedDB (browser-local) | Client-side only | No |
| **Self-hosted LAN** | Personal server on local network | Bridge server → filesystem | Client-side + optional LAN auth | Single (or per-file) |
| **Docker / LXC** | Containerized self-host | Bridge server (bundled) → volume | Client-side + optional proxy auth | Single (or per-file) |
| **SaaS** | Multi-tenant cloud service | Cloudflare Worker → R2 / S3 | Registration service + API keys | Multi-tenant |

### 11.2 Architecture Stack

The key insight: the **UI and sync logic are deployment-agnostic**. Only the storage backend changes per deployment target.

```
┌──────────────────────────────────────────────────────────────┐
│                    phpoc-web (React)                          │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────┐ │
│  │ Auth     │ │ Dashboard│ │ History  │ │ Settings        │ │
│  │ Screen   │ │          │ │          │ │ (import/export) │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────────┬────────┘ │
│       │            │            │                 │          │
│  ┌────▼────────────▼────────────▼─────────────────▼────────┐ │
│  │              SyncService / LedgerEngine                   │ │
│  │     (same logic, no matter where data lives)             │ │
│  └───────────────────────┬──────────────────────────────────┘ │
│                          │                                    │
│  ┌───────────────────────▼──────────────────────────────────┐ │
│  │              StoragePlugin (interface)                    │ │
│  │  get(key), put(key, data), list(prefix), delete(key)     │ │
│  └──────┬──────────┬──────────┬──────────┬──────────────────┘ │
│         │          │          │          │                    │
└─────────┼──────────┼──────────┼──────────┼────────────────────┘
          │          │          │          │
    ┌─────▼──┐  ┌────▼───┐  ┌───▼────┐  ┌───▼────────────┐
    │Indexed │  │Local   │  │Remote  │  │ S3/R2 Plugin   │
    │DB      │  │Bridge  │  │Worker  │  │ (advanced      │
    │Backend │  │Server  │  │(SaaS)  │  │  deployments)  │
    └────────┘  └────────┘  └────────┘  └────────────────┘
    PWA mode    self-hosted  SaaS        future: BYO S3
```

### 11.3 StoragePlugin Interface

The interface that makes all deployments possible:

```js
class StoragePlugin {
  async get(key) { /* throw — abstract */ }
  async set(key, value) { /* throw — abstract */ }
  async remove(key) { /* throw — abstract */ }
  async clear() { /* throw — abstract */ }
  async list(prefix) { /* throw — abstract */ }
}
```

**Concrete implementations:**

| Implementation | File | Backend | Persistence |
|---|---|---|---|
| `MemoryBackend` | `src/sync/storage.js` | In-memory `Map` | Process lifetime (Node testing) |
| `IndexedDBBackend` | `src/sync/indexeddb_storage.js` | Browser IndexedDB | Across page reloads (PWA mode) |
| `HttpBackend` | `src/sync/http_backend.js` | Remote HTTP (Worker or bridge) via Transport wrapper | Remote server |
| `MockRemoteBackend` | `src/sync/mock_remote.js` | IndexedDB partition | Dev/temp (archivable) |

> **Note:** The codebase uses the name `StorageBackend` (in `storage.js`) rather than `StoragePlugin`.
> The actual `HttpBackend` lives in `src/sync/http_backend.js` (not `transport.js` as originally planned).
> It wraps a Transport (HttpTransport or MockRemoteBackend) rather than talking directly to HTTP.
> The interface methods are `get/set/remove/clear/list` (using `remove` not `delete`, `set` not `put`).

**Config-driven selection** (not yet wired — currently hardcoded in `DevModeContext.jsx`):

```js
// Future factory function in src/sync/storage_plugin.js
export async function createStoragePlugin(config) {
  switch (config.storageMode) {
    case 'standalone':
      return new IndexedDBBackend();
    case 'self-hosted':
    case 'docker':
      return new HttpBackend({ baseUrl: config.bridgeUrl });
    case 'saas':
      return new HttpBackend({
        baseUrl: config.workerUrl,
        apiKey: config.apiKey,
      });
    case 'dev':
      return new MockRemoteBackend({ latencyMs: 30 });
    default:
      return new IndexedDBBackend();
  }
}
```

### 11.4 Two Transport Interfaces

The project uses two distinct interfaces for different purposes, which must not be confused:

| Interface | File | Purpose | Methods |
|---|---|---|---|
| `StorageBackend` / `StoragePlugin` | `storage.js` | Local cache (IndexedDB, Memory) | `get`, `set`, `remove`, `clear`, `list` |
| `Transport` | `transport.js` | Remote blob I/O (HTTP, mock) | `pull(path)`, `push(path, data)`, `listFiles(prefix)`, `resetCache()` |

The `SyncService` brokers between them:
- **Local cache** → `StorageBackend` (for fast reads, offline access, merge base)
- **Remote storage** → `Transport` (for sync, push, pull across devices)

### 11.5 Deployment Data Flow

```
                           ┌─────────────────────┐
                           │   Browser Tab        │
                           │  ┌───────────────┐   │
                           │  │ IndexedDB      │   │  ← Local cache (always present)
                           │  │ (phpoc-sync)   │   │
                           │  └───────┬───────┘   │
                           │          │            │
                           │  ┌───────▼───────┐   │
                           │  │ SyncService   │   │  ← CheckAndSync / Commit
                           │  └───────┬───────┘   │
                           │          │            │
                           │  ┌───────▼───────┐   │
                           │  │ Transport     │   │  ← Remote: Worker, bridge, or mock
                           │  └───────┬───────┘   │
                           └──────────┼────────────┘
                                      │
                        ┌─────────────┼─────────────┐
                        │             │             │
                   ┌────▼───┐   ┌────▼───┐   ┌────▼───┐
                   │ Worker  │   │ Bridge │   │ Mock   │
                   │ (SaaS)  │   │ (LAN)  │   │ (Dev)  │
                   └────┬───┘   └────┬───┘   └────────┘
                        │             │
                   ┌────▼───┐   ┌────▼────┐
                   │   R2   │   │  Local  │
                   │        │   │  files  │
                   └────────┘   └─────────┘
```

### 11.6 The Bridge Server (Self-Hosted / LAN / Docker)

A minimal HTTP server implementing the same API contract as the Cloudflare Worker — same paths, same verbs, same response format. The web app cannot tell the difference.

```
# Python bridge_server.py (~80-100 lines)
# GET  /staging/blobs/current.json        → read local file
# PUT  /staging/blobs/current.json        → write local file
# GET  /ledger/blocks/0.json              → read block file
# GET  /?prefix=ledger/blocks/            → list matching files
```

This server is:
- **Optional** — standalone PWA mode skips it entirely
- **Swappable** — same API as the Worker; dev → prod = one config change
- **Bundleable** — ships in the Docker image alongside the static web build
- **Language-agnostic** — can be Python, Node.js, or any HTTP-capable runtime

### 11.7 SaaS: Multi-Tenant Architecture

The SaaS deployment uses the same stack with user isolation layered in:

```
                     ┌──────────────────────┐
                     │  phpoc-web (browser)  │
                     │  - client-side crypto │
                     │  - IndexedDB cache   │
                     │  - SyncService       │
                     └──────────┬───────────┘
                                │  HTTP (TLS)
                     ┌──────────▼───────────┐
                     │  Cloudflare Worker   │
                     │  (dumb blob store)   │
                     │  prefix: /users/{id} │
                     └──────────┬───────────┘
                                │
                     ┌──────────▼───────────┐
                     │  R2 Object Storage   │
                     │  /users/{id}/staging/ │
                     │  /users/{id}/ledger/  │
                     └──────────────────────┘

                     ┌──────────────────────┐
                     │  Auth Service        │  ← Lightweight, separate
                     │  POST /register      │
                     │  POST /login         │
                     │  (KV-backed)         │
                     └──────────────────────┘
```

**Key properties:**
- **Zero-knowledge by design.** The server stores opaque encrypted bytes. It cannot read user data.
- **User isolation is path-prefix based.** No shared tables, no multi-tenant database schema.
- **Auth is minimal.** A registration service (~50 lines, can be a second Worker) that creates `user_id` + API key. No user profile data stored.
- **Import/export via File API.** Browser-native download/upload for backup. No server involved.

### 11.11 Import/Export Design (2026-06-09, updated 2026-06-11)



**Auth gate:**
- Both import and export require passphrase entry via modal prompt before proceeding
- Passphrase → `crypto.authenticate()` → master key
- In dev mode (`DummyCryptoService`), any passphrase is accepted — UX convention
- When real WASM crypto is wired (Step 9), the passphrase becomes real authentication

**Export flow:**
1. User taps **Export Ledger** in Settings
2. Passphrase prompt (modal overlay)
3. `sync.readEntries()` → entry DTOs
4. `JSON.stringify(entries)` → `crypto.computeSeal(string, masterKey)` → seal hex
5. Write file: `{ format_version, exported_at, entries, seal }`
6. Browser-native download via `<a download>` → `.json` file

**Import flow:**
1. User taps **Import Ledger** in Settings
2. File picker → select `.json` file
3. Parse → auto-detect format (v1 export, v2 export, or raw chain)
4. Passphrase prompt (modal overlay)
5. `crypto.verifySeal(entriesJson, seal, masterKey)` — **mismatch → reject entirely, show error**
6. Recompute each entry's `hash` and compare — **any mismatch → reject entirely, show error**
7. `sync._local.writeEntries(parsed.entries)` → replace all local entries
8. UI refreshes to show imported data

**File formats (three supported):**

| Format | Detected by | Seal scope | Validation |
|--------|-------------|-----------|------------|
| v1 export | `{ format_version: "1", entries, seal }` | File-level: `seal` over `JSON.stringify(entries)` | Seal + entry hash recalc |
| v2 export | `{ format_version: "2", ledger, staging, seal }` | File-level: `seal` over `JSON.stringify({ledger, staging})` | Seal + entry hash recalc |
| **Raw chain** | Top-level `[...]` JSON array | Per-block: each block has its own `day_hash`/`month_hash`/`year_hash` | Per-block seal + `prev_hash` chain linkage + entry hash recalc |

```json
// v1 export (staging-only)
{
  "format_version": "1",
  "exported_at": "2026-06-09T14:30:00.000Z",
  "entries": [ /* StagingEntry[] */ ],
  "seal": "abc123..."
}

// v2 export (committed chain + staging)
{
  "format_version": "2",
  "exported_at": "2026-06-11T12:00:00.000Z",
  "ledger": [ /* Block[] — committed chain */ ],
  "staging": [ /* StagingEntry[] */ ],
  "seal": "abc123..."
}

// Raw chain (CLI ledger.json — JSON array of blocks)
[
  { "type": "genesis", "date": "2026-04-23", "day_hash": "..., "entries": [], ... },
  { "type": "day", "date": "2026-04-23", "day_hash": "..., "entries": [...], "prev_hash": "...", ... },
  ...
]
```

- `entries` — the user's ledger data (staging entry DTOs). Device-agnostic, system-agnostic.
- `seal` — HMAC-SHA256 (PHPSPEC §5.2 `computeSeal`) of `JSON.stringify(entries)` only. Proves the ledger was exported by the same master key and hasn't been tampered with.
- `exported_at` — informational timestamp for user transparency (e.g. backup log display). Sits outside the seal. Not part of the ledger.
- `format_version` — allows format evolution (entries-only for now; could add ledger blocks in v2).

**Cross-platform JSON compatibility (2026-06-11):**

A critical finding during raw chain import development: Python's `json.dumps(obj, sort_keys=True)` and JavaScript's `JSON.stringify(obj)` produce **different output** for the same object:

| Aspect | Python `json.dumps(sort_keys=True)` | JavaScript `JSON.stringify()` |
|--------|-------------------------------------|-------------------------------|
| Key sorting | All keys at **all nesting levels** sorted alphabetically | No sorting — insertion order preserved |
| Separators | `": "` (colon-space) and `", "` (comma-space) | `":"` (colon) and `","` (comma) — compact |

This means a SHA-256 hash computed in Python vs JavaScript will differ even for identical data. Since the CLI computes entry hashes and block seals in Python, the web app needs a Python-compatible JSON serializer for verification. The `jsonDumps()` helper in `ledger_import.js` handles this:

```js
function jsonDumps(obj, sortedKeys = null) {
  if (obj === null) return 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(v => jsonDumps(v)).join(', ') + ']';
  }
  const keys = sortedKeys || Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ': ' + jsonDumps(obj[k])).join(', ') + '}';
}
```

This is only needed when verifying Python-computed hashes (raw chain import). The export format uses JavaScript-native `JSON.stringify` for both seal creation (export) and seal verification (import) — no cross-platform translation needed.

**Key decisions:**
- Ledger is defined as the entries array only — no cookie, no device identity, no app metadata
- File wrapper metadata (`exported_at`, `format_version`) sits outside the sealed region
- Import always overwrites (replaces) local entries — no merge
- Verification failure (seal or entry hash) → reject entirely, no partial import
- Active task flags (`is_active`, `is_paused`) preserved as-is on import
- Raw chain imports return `{ entries: [], ledger: blocks, formatVersion: 'chain' }` — all entries are in the committed chain, not staging

**UI placement:**
- New **Backup & Restore** section in Settings screen
- Two buttons: Export Ledger, Import Ledger
- Passphrase prompt: lightweight modal overlay (reuses pattern from AuthScreen overlay)

### 11.8 Data Layer Per Deployment

| Layer | PWA | Self-Hosted | Docker | SaaS |
|---|---|---|---|---|
| UI rendering | Browser | Browser | Browser | Browser |
| Local cache | IndexedDB | IndexedDB | IndexedDB | IndexedDB |
| Remote storage | _(none)_ | Local filesystem | Container volume | R2 bucket |
| Sync endpoint | _(none)_ | `http://host:port/` | `http://container:port/` | `https://api.phpoc.app/` |
| Auth | Client-only | Client-only + LAN opt | Client-only + proxy opt | Registration + API keys |
| Import/Export | File API | File API + bridge FS | File API + volume | File API |
| Multi-user | No | No (file-per-user) | No (file-per-user) | Yes (path-prefix) |

### 11.9 Roadmap

| Step | What | Delivers | Dependencies |
|---|---|---|---|
| 1 | StoragePlugin interface + IndexedDBBackend + HttpBackend + config-driven selection | Interface, IndexedDBBackend, HttpBackend exist. Config-driven factory NOT yet wired. | None |
| 2 | **MockRemoteBackend** (in-browser R2 simulation) | ✅ Complete (46 tests) — dev mode uses real SyncService + mock remote | Step 1 (interface) |
| 3 | Browser import/export via File API | ✅ Complete (83 tests) — `exportLedger()`, `importLedger()`, `PassphraseModal`. Auth-gated, HMAC-sealed, single `.json` file format. | None |
| 4 | Ledger engine port to JS | Web becomes self-sufficient (no Python dependency) | Step 1 (storage) |
| 5 | Staging CRUD (add/edit/delete entries in UI) | Full staging interaction | Step 4 (ledger engine) |
| 6 | Companion bridge server (Python or Node.js) | Self-hosted + LAN deployments work | Step 1 (interface contract) |
| 7 | Dockerfile (nginx + bridge server) | One-command self-hosted deployment | Step 6 |
| 8 | Multi-tenant Worker (user isolation) + registration service | SaaS deployment | Step 1 (transport contract) |
| 9 | Real crypto (WASM) replaces DummyCryptoService | Production-ready crypto | Step 4 (ledger engine) |

### 11.12 Ledger Engine JS Port — Design Decisions (2026-06-10)

**Storage integration (Option B):** Direct `StorageBackend` consumption — no adapter layer.
The `LedgerChain`, `IndexManager`, and `LedgerEngine` classes use the same `StorageBackend`
interface (from `storage.js`) that the sync layer already uses, rather than introducing
separate `AbstractLedgerStore` / `AbstractIndexStore` adapter classes.

| Dimension | Decision | Rationale |
|-----------|----------|-----------|
| Storage interface | Direct `StorageBackend` | Single consistent abstraction across the codebase. Every other module (`SyncService`, `LocalCache`, `HttpBackend`) uses it directly. Adding parallel Python-style abstract stores would be the *only* second storage pattern. |
| Key convention | `ledger:blocks` (JSON array), `ledger:index` (JSON dict) | Simple, discoverable, same pattern as other modules. No adapter boilerplate needed. |
| Block format | Byte-identical to CLI (`domain/ledger/chain.py`) | 🔴 O8 constraint from `__init__.py`. Test fixtures include known-good block structure verified against CLI output. |

**TDD approach:** Four modules tested in dependency order (bottom-up):

| Order | Module | Test file | Assertions | Depends on |
|-------|--------|-----------|------------|------------|
| 1 | `LedgerChain` — block operations | `test/ledger_chain_test.mjs` | 40 | `CryptoService` calls (`seal`, `verifySeal`, `sign`, `sha256`) + `StorageBackend` |
| 2 | `IndexManager` — blind index | `test/index_manager_test.mjs` | 22 | `StorageBackend` (key `ledger:index`) |
| 3 | `SummaryPolicy` — boundary summaries | `test/summary_policy_test.mjs` | 21 | `CryptoService` calls (`seal`, `sign`) |
| 4 | `LedgerEngine` — commit/verify/revert | `test/ledger_engine_test.mjs` | 50 | All above + `CryptoService` (`encrypt`, `decrypt`, `seal`, `sha256`) + `StorageBackend` |

**Test coverage highlights:**
- `LedgerChain`: seal/sign helpers, `buildDayBlock()` structure, day_index auto-increment, entry hash computation, pre-hashed vs raw entries, optional identity signature, `appendBlocks()` linkage rejection, `truncate()` preserves genesis, `verify()` catches tampered seal/tampered prev_hash/tampered entry hash/tampered signature, `verifyBlock()` edge cases
- `IndexManager`: `update()` create/accumulate/remove-at-zero/remove-date, `query()` range/single-day/from>to/partial-overlap, `clear()`, `reload()` picks up external changes, `getAll()` returns defensive copy
- `SummaryPolicy`: `YearMonthSummaryPolicy` boundary detection (same month, month-only, year+month, cross-year Dec→Jan→Feb, skip-month Dec→Feb), no-redundant-after-year-summary, identity signature support; `YearOnlySummaryPolicy` (year-only, no month); `NoSummaryPolicy` (always empty); all policies return empty array not null for no-op
- `LedgerEngine`: empty commit, single-day/multi-day grouping, field encryption (`startTime_enc`, `endTime_enc`, `metadata_enc`, `pauses_enc`), content_hash computation, staging-only field removal (start_epoch, end_epoch, pauses, metadata, is_active, is_paused), month boundary summary insertion, year boundary summary insertion (+12→month), verify catches tampered chain, revert restores entries and updates index negatively, revert too-many returns -1, revert removes summary blocks between reverted days, rebuildIndex scans chain, edge cases (empty title, zero duration, empty chain)

**Current status (2026-06-10):** ✅ COMPLETE — All 4 modules GREEN, 246 assertions, 0 failures. Source files at `src/ledger/{chain,index_manager,summary_policy,engine}.js` are fully functional. Test-only fixes were needed: 4 epoch timestamps corrected (hardcoded `1704153600000` maps to 2024, not 2025), 1 tampered-seal test strengthened (mock hash collision), 2 missing `await` keywords added. Zero regressions against existing 353 web tests.

**CLI reference mapping:**

| Python file | JS port | Key structural differences |
|---|---|---|
| `domain/ledger/chain.py` | `src/ledger/chain.js` | Uses `StorageBackend.get/set('ledger:blocks')` instead of `AbstractLedgerStore.read_blocks/append_blocks` |
| `domain/ledger/index_manager.py` | `src/ledger/index_manager.js` | Uses `StorageBackend.get/set('ledger:index')` instead of `AbstractIndexStore` |
| `domain/ledger/summary_policy.py` | `src/ledger/summary_policy.js` | JS idiomatic: object with `getSummaryBlocks()` returning array instead of Python polymorphism |
| `domain/ledger/engine.py` | `src/ledger/engine.js` | Optional `identitySecret` parameter instead of Python's duck-typed `identity_secret` |
| `domain/ledger/__init__.py` | N/A | Design doc only — the 🔴 O8 constraint is enforced by test fixtures |

**Steps 1–5 are in-browser only** — zero server code required. Steps 6–9 layer on deployment options.

### 11.13 Step 6 Code Review — Findings (2026-06-10)

A code review of the Ledger Engine JS port identified 16 findings across three areas: Modularity (5), Clarity (6), and Security (5). The full review is in `SESSION_HANDOFF.md`; this section captures the design-affecting decisions only.

**Design-impacting findings:**

| # | Area | Finding | Design Decision |
|---|------|---------|-----------------|
| 6 | Clarity | `buildDayBlock` (sync) duplicates `buildDayBlockAsync` (async); exists only for synchronous test calls | Remove sync version. Update tests to `await buildDayBlockAsync`. Remove `_blockCache`. |
| 7 | Clarity | `_blockCache` side-effect in `_getBlocks()` is a caching layer consumed only by the sync `buildDayBlock` | Eliminated as a consequence of #6. |
| 1 | Modularity | `sortKeys`/`jsonSort`/`computeEntryHash` duplicated between `chain.js` and `engine.js` | Extract to `src/ledger/utils.js`. Both files import from shared utility. |
| 5 | Modularity | `getPrevHash` pattern (`day_hash \|\| month_hash \|\| year_hash`) duplicated across 3 files | Move to `utils.js` as `getBlockHash(block)`. |
| 8 | Clarity | `IndexManager._flush()` and `reload()` are fire-and-forget — silently broken with IndexedDBBackend/HttpBackend | Make both properly async; all call sites must `await`. |
| 12 | Security | `_computeContentHash` silently swallows `decrypt()` errors (line 334 of `engine.js`) | Propagate error. A decrypt failure indicates wrong key or tampered data — must not produce a valid content hash. |
| 13 | Security | `verifyBlock(0)` only checks `block.type` validity; `verify()` block-0 checks seal + entry hashes | Align `verifyBlock(0)` with `verify()` by delegating to `_verifyBlockData()`. |
| 14 | Security | Missing `signature` field passes verification even when `identitySecret` is configured | Fail verification for missing signatures when `identitySecret` is set. |
| 15 | Security | `IndexManager.reload()` reaches into `this.store._store` (MemoryBackend private internals) | Use async `this.store.get()` path uniformly. |

**Refactoring is organized into 3 sequential phases** (2026-06-11, all ✅ COMPLETE):

| Phase | Area | Findings | Status | Outcome |
|-------|------|----------|--------|---------|
| 1 | Modularity | 5 | ✅ Complete | `utils.js`, `mock_crypto.mjs`, `test_helpers.mjs` extracted. ~100 LOC net reduction. |
| 2 | Clarity | 6 | ✅ Complete | Sync dead code removed, fire-and-forget → async, staging persistence, array sort fix. +7 new tests. |
| 3 | Security | 5 | ✅ Complete | Decrypt error propagation, verifyBlock(0) integrity, missing signature enforcement, reload interface test, input validation. +10 new tests, 3 mutation fixes. |

**Final metrics:** 266 assertions across 4 suites, 0 failures. Zero regressions in 787 total web tests.

### 11.14 Genesis Block Creation — Design Decisions (2026-06-11)

**Problem:** The onboarding flow collected only a passphrase and stored the seed as a flat IndexedDB key. No genesis block was created, violating PHPSPEC §4.1 which requires block 0 of the ledger chain to be a genesis block with a full identity object.

**Solution:** Added `LedgerChain.buildGenesisBlock()` which produces a PHPSPEC-compliant genesis block:

| Step | Operation | PHPSPEC Ref |
|------|-----------|-------------|
| 1 | Generate 32-byte identity secret via `generateSeed()` + `deriveMasterKey()` | §2.7.1 |
| 2 | Compute `identity_pub_key = SHA-256(identity_secret)` | §2.7.1 |
| 3 | Derive PDK via PBKDF2(passphrase, "session-salt", 600K) | §2.4 |
| 4 | Encrypt recovery seed with PDK → `recovery_seed_enc` | §2.5 |
| 5 | Encrypt identity secret with master key → `identity_secret_enc_fallback` | §2.7.2 |
| 6 | Build `identity` object with username, email, encrypted fields | §4.1 |
| 7 | Compute HMAC-SHA256 seal over block (excluding day_hash, signature) | §5.2 |
| 8 | Sign day_hash with identity secret | §5.3 |

**Architecture:**
- `buildGenesisBlock()` is a method on `LedgerChain`, following the same pattern as `buildDayBlock()`
- `LedgerEngine.init()` orchestrates: `chain.buildGenesisBlock()` → `chain.append()`
- `DevModeContext.createNewLedger()` creates a `LedgerEngine`, calls `init()`, stores the identity secret hex for future use
- The genesis block is appended as block 0 in the `ledger:blocks` array, making it the canonical source of identity data
- Flat IndexedDB keys (`phpoc_seed`, `phpoc_username`, `phpoc_email`, `phpoc_identity_secret`) are retained as a cache alongside the canonical genesis block

**CryptoService primitives used:**
- `generateSeed()` — 32 random bytes, base64-encoded
- `deriveMasterKey(seed)` — base64 decode → 64-char hex
- `derivePdk(passphrase, iterations)` — PBKDF2-HMAC-SHA256
- `encrypt(plaintext, keyHex)` — AES-128-CTR + auth tag, works with both PDK and master key
- `sha256(data)` — hash identity secret for public key
- `seal(data, masterKey)` — HMAC-SHA256 with sealing sub-key derivation
- `sign(data, secretHex)` — raw HMAC-SHA256 for identity signature

**Key files:**
- `phpoc-web/src/ledger/chain.js` — `buildGenesisBlock()`
- `phpoc-web/src/ledger/engine.js` — `init()`
- `phpoc-web/src/context/DevModeContext.jsx` — updated `createNewLedger()`
- `phpoc-web/src/components/screens/OnboardingScreen.jsx` — username + email fields
- `phpoc-web/src/components/screens/UserProfile.jsx` — displays username + email

### 11.15 History Screen: Staging vs Committed Differentiation (2026-06-11)

**Problem:** The History screen showed all completed entries without distinguishing which had been persisted to the ledger chain. Users had no feedback on whether their data was backed up.

**Solution:** Added a `committed` (boolean) and `block_index` (number|null) tracking field to `StagingEntry`, and modified `LedgerEngine.commit()` to return committed entry IDs so the caller can mark them.

| Component | Change |
|-----------|--------|
| `local_cache.js` | `StagingEntry` typedef now includes `committed` (default `false`) and `block_index` (default `null`). Added `markCommitted(entryIds, blockIndex)`. |
| `sync.js` | Exposes `markCommitted()` from LocalCache. |
| `engine.js` | `commit()` returns `{hashPrefix, committedEntryIds, blockIndex}` instead of bare string. `_commitDay()` returns the block's `day_index`. |
| `DevModeContext.jsx` | Added `commitEntries()` wrapper — creates `LedgerEngine`, calls `commit()`, then `markCommitted()`. |
| `History.jsx` | Display-only. Cards show a green ✓ Committed badge or yellow ⏱ Not Committed badge. Tags & comments hidden by default — click to expand. Staging cards have a red border (blue when expanded) and show a checkmark on the badge when expanded. No commit UI buttons. |
| `App.css` | `.badge-committed`, `.badge-staging`, `.badge-staging-count`, `.history-entry-staging` (red border), `.history-entry-expanded` (blue border). |

**Design decisions:**
- **History is display-only** — the commit UI lives on a future Sync screen, keeping each screen focused on one responsibility.
- **Staging entries sorted first** within each date group so pending items are always visible.
- **Tags and comments hidden by default** — reduces visual noise. Click to expand reveals them with a smooth transition.
- **Red border for staging, blue when expanded** — gives immediate visual feedback that the entry needs attention, and the blue border confirms the expanded state.

**Tests:** Engine tests grew from 111 to 114 (extra assertions on new `commit()` return shape). All 269 ledger tests pass.

### 11.16 Inline Tag & Comment Editing on Staging Entries (2026-06-11)

**Problem:** Users could view tags and comments on expanded cards but couldn't modify them in-place. Editing required external tools.

**Solution:** When a staging (not-committed) card is expanded, tags and comments become editable inline.

**Tag editing:**
- Each tag badge (`#tagname`) shows a small **×** button on the right
- Clicking × immediately removes the tag and saves via `sync.modify(entry_index, { tags })`
- A dashed-border `+tag` input appears at the end of the tag row
- Typing and pressing **Enter** adds the tag (lowercased, deduplicated, sorted)
- Tags are saved instantly on each add/remove operation

**Comment editing:**
- The comment becomes a `<textarea>` pre-filled with existing text
- Changes auto-save after **800ms** of no typing (debounce timer)
- Also saves immediately on textarea blur
- Blank textarea → comment saved as `null` (cleared)

**Visual feedback:**
- A small spinning dot appears beside the "Not Committed" badge during save
- Clicking the × button, tag input, or textarea does **not** collapse the card (`e.stopPropagation()`)
- Committed entries remain read-only (tags as plain badges, comments as static text)

**Architecture:**
- Editing state stored in React: `editTags`, `editTagInputs`, `editComments` (maps keyed by `entry_id`)
- Changes saved via `sync.modify(entry_index, fields)` → `LocalCache.update()` → recomputes hash
- Editing state initialized on expand, cleared on collapse

**Key files:** `History.jsx`, `App.css` (`.tag-badge-remove`, `.tag-add-input`, `.history-entry-comment-edit`, `.saving-spinner`)

### 11.17 Export Works in Dev Mode (2026-06-11)

**Problem:** Export forced re-authentication by reading `phpoc_seed` from storage. In dev mode, no seed was stored — the crypto had a hardcoded master key set during bootstrap. Export threw "No recovery seed found".

**Solution:** Added a cached-master-key check to both fast and slow export paths:

```js
// Before (broken in dev mode):
const seed = await storage.get(STORED_SEED_KEY);
const masterKey = crypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS);

// After (works in both modes):
let masterKey = crypto.getMasterKey();  // try cache first
if (!masterKey) {
  const seed = await storage.get(STORED_SEED_KEY);
  masterKey = crypto.authenticate(passphrase, seed, PBKDF2_ITERATIONS);
}
```

**Key files:** `DevModeContext.jsx` (`exportLedgerAction`)

### 11.18 Recovery Seed Display After Onboarding (2026-06-11)

**Problem:** After creating a new ledger, the recovery seed was silently stored in IndexedDB. Users had no way to back it up or know it existed.

**Solution:** Added a one-time full-screen overlay after successful onboarding:
- Shows the base64 seed in a large monospace code block (`user-select: all` for easy copy)
- "Write this down and keep it somewhere safe" instruction
- ⚠ Warning about data loss if seed is lost
- "I've saved it" button dismisses the overlay permanently
- The overlay appears on top of the ready-phase app (phase transitions to 'ready' first)

**Architecture:**
- `createNewLedger()` now returns `{ seed }` so the caller can display it
- `App.jsx` manages `recoverySeed` + `seedConfirmed` state
- Not shown again on refresh (seed is already stored in IndexedDB)

**Key files:** `App.jsx`, `App.css` (`.seed-overlay-backdrop`, `.seed-overlay`, `.seed-overlay-code`)

### 11.19 Logout Button + Bug Fixes (2026-06-11)

**Changes:**
- Renamed "Lock & Re-authenticate" to **"Logout"** with exit-door icon (`Icons.logout`)
- Clears crypto master key from memory and returns to Landing screen

**Bug fixes:**
1. **Blank screen after logout** — LandingScreen checked `hasExistingData` which defaulted to `false` in dev mode (never set during `bootDevMode`). Fixed by setting `hasExistingData=true` in `logout()`.
2. **In-memory data loss on re-login** — `createStorage()` created a new `FallbackStorage` each call, losing all data from the previous session. Fixed by caching the `FallbackStorage` instance at module level.
3. **Storage reference lost** — `logout()` set `services.storage = null`, so re-login had no access to existing data. Fixed by retaining `services.storage` in logout.

**Key files:** `AppLayout.jsx`, `DevModeContext.jsx` (`logout`, `createStorage`)

### 11.10 Current Status (2026-06-09)

| Step | Status | Notes |
|---|---|---|
| 1 — StoragePlugin interface | ✅ `StorageBackend`, `MemoryBackend`, `IndexedDBBackend`, `HttpBackend` exist | Config-driven factory not yet wired. `list(prefix)` added to StorageBackend. `delete()` added to HttpTransport + MockRemoteBackend. DELETE handler added to Worker. |
| 2 — MockRemoteBackend | ✅ Complete | 46 tests, 300 total across mock infra |
| 3 — Import/Export | ✅ Complete (83 tests) | `exportLedger(entries, crypto, masterKey)` → signed JSON Blob. `importLedger(file, crypto, masterKey)` → `{entries, count}`. `PassphraseModal.jsx` — reusable passphrase prompt overlay (reuses AuthScreen pattern). 3 test suites: 24 (export), 26 (import), 33 (modal). Auth-gated (passphrase → `crypto.authenticate()` → master key). Seal = HMAC-SHA256 of `JSON.stringify(entries)` only. Entry hash re-validation on import. Reject entirely on any failure. Settings screen wiring pending (Backup & Restore section). |
| 4 — Ledger engine JS port | ✅ Complete (266 tests) | All 4 modules GREEN — Chain (70), Index (36), Summary (49), Engine (111). Direct `StorageBackend` consumption with key convention `ledger:blocks`/`ledger:index`. No adapter layer. **Step 6 Refactoring complete (3 phases, 16 findings resolved).** Zero regressions. |
| 5 — Staging CRUD | ⚠️ Partial | UI scaffold exists, wired to dummy data |
| 6 — Bridge server | ❌ Not started | |
| 7 — Dockerfile | ❌ Not started | |
| 8 — Multi-tenant Worker | ❌ Not started | |
| 9 — Real crypto | ❌ Not started | WASM binary exists, needs web integration |
| 10 — Genesis block (PHPSPEC §4.1) | ✅ Complete | `LedgerChain.buildGenesisBlock()` + `LedgerEngine.init()` produce spec-compliant genesis block with identity, encrypted seed/secrets, HMAC seal, and identity signature. Onboarding form collects username + email. |
| 11 — History screen: staging vs committed | ✅ Complete | History shows real SyncService data with collapsible details. Badges: green "Committed" / yellow "Not Committed". Red border for staging (blue when expanded). `StagingEntry` tracks `committed` + `block_index`. `commit()` returns entry IDs. 269 ledger tests. |
| 12 — Inline tag & comment editing | ✅ Complete | Staging entries in History: add/remove tags (× buttons, +input with Enter), edit comments (textarea debounced auto-save). Committed entries read-only. |
| 13 — Export works in dev mode | ✅ Complete | Uses cached master key when available, skips seed auth. Any passphrase works in dev mode. |
| 14 — Recovery seed display | ✅ Complete | Full-screen overlay after onboarding shows base64 seed, "I've saved it" confirm button. |
| 15 — Logout button + fixes | ✅ Complete | Renamed from Lock to Logout. Fixed blank screen (hasExistingData). Fixed in-memory data loss (FallbackStorage caching). |
| 16 — Sync screen with Commit UI | ✅ Complete | Dedicated Sync screen. Uncommitted entries (active + stopped) as compact pills. Stopped: yellow border/left syncability indicator, expandable inline tag & comment editing. Active: red border, lock icon, non-expandable. Commit Selected/Commit All buttons. NOT_SYNCED status when staging has entries. Tag-add input restyled (blue badge, white text, black border). |
| 17 — One-off task checkbox | ✅ Complete | Dashboard "Start New Task" form: ☐ one-off checkbox next to title input. When checked: button changes to "Log", capture calls sync.capture() with isActive=false + endEpoch=now (immediate close). When unchecked: normal timed task with "Start" button. |
| 18 — Full ledger export + import interface | ⚠️ v2 chain loss bug | `exportLedgerFull(blocks, staging, crypto, masterKey)` — v2 format with committed chain + staging, HMAC seal over {ledger, staging}. Pure read — never commits. 72 tests with real mock ledger data (97 blocks, 205 entries). `importLedger` updated to handle both v1/v2 formats, returns genesisHash. DevModeContext import action checks genesis match: same genesis → reject with merge-not-supported message (open interface for future merge logic); different genesis → replace. **Known bug:** v2 import discards committed chain — `importLedger()` returns only staging entries, never writes `ledger:blocks`. |
| 19 — Import security analysis | ✅ Confirmed | Passphrase verification happens before any destructive operations. Five read-only validation gates (parse → seal verify → entry hash re-validate → genesis check) pass before `storage.clear()`. Wrong passphrase or tampered file rejected with zero impact on existing data. Staging entries confirmed cryptographically portable across ledgers (plaintext commit fields, genesis hash not in entry hash per PHPSPEC §5.4). |
| 20 — Import workflow enhancement | 🔜 Planned | Two safety gates before `storage.clear()`: (A) destroy warning + offer to export current ledger via `exportLedgerFull()`; (B) offer to keep uncommitted staging entries (both stopped and running) merged into imported staging area. |

### 11.20 Sync Screen Design (2026-06-11)

**Problem:** The old SyncSettings screen showed only sync status (READY/OFFLINE/REAUTH) with a manual Sync Now button. There was no way to see which entries were uncommitted, select them for committing, or manage tags/comments inline during the sync flow.

**Solution:** Complete rewrite of `SyncSettings.jsx` into a full-featured Sync screen.

**Layout (portrait, default):**

```
┌──────────────────────────────┐
│  Sync                    [↻] │  ← Screen header
├──────────────────────────────┤
│  [☐] ✓ Completed Task   12m  │  ← Compact pills for stopped
│  #tag1  #tag2          [×]▶ │     entries (expandable)
│  ┌────────────────────────┐  │
│  │ [+tag]                │  │
│  │ Add a comment…        │  │
│  └────────────────────────┘  │
│  🔴 ▶ Active Task       5m  │  ← Active entries (compact, locked)
│  (scrollable)               │
├──────────────────────────────┤
│  [Commit Selected (N)]       │  ← Commit button bar
│  [Commit All (N)]            │
├──────────────────────────────┤
│  Status    ● Synced          │  ← Sync status info
│  Last push 2:30 PM           │
│  Remote    ✅ Configured     │
└──────────────────────────────┘
```

**Design decisions:**

1. **Three-zone layout** — scrollable entries list (top), commit button bar (middle), sync status (bottom). The commit bar acts as a visual separator between actionable entries and passive status info.

2. **Color-coded syncability indicators:**
   - **Yellow** border + left indicator → stopped entry, ready to commit
   - **Red** left indicator → active entry, cannot commit yet
   - On hover, border changes to blue for interactive feedback

3. **Expand/collapse for stopped entries only** — clicking a stopped card toggles the inline editing panel (tags + comment). Active entries are compact-only and non-interactive.

4. **Checkbox operates independently** — clicking the checkbox toggles selection without triggering expand/collapse (`e.stopPropagation()`). This allows batch operations on collapsed cards.

5. **Inline tag editing** — reuses the same pattern as History.jsx:
   - × buttons on each tag to remove
   - `+tag` input (Enter to confirm, deduplicated, lowercased)
   - Tags saved instantly via `sync.modify(entry_index, { tags })`

6. **Inline comment editing** — textarea with debounced auto-save (800ms), saves on blur too. Matches History.jsx behavior.

7. **Active entries** show a 🔒 lock icon (red circle), no checkbox, no expand — they visually communicate "not ready for sync."

8. **Expanded state is pruned** — when entries are removed from the list (e.g. committed by another session or removed), their editing state is cleaned up.

9. **Backend fix:** `commitEntries()` in `DevModeContext.jsx` now returns the `{hashPrefix, committedEntryIds, blockIndex}` result from `LedgerEngine.commit()`, enabling the Sync screen to display commit confirmation details.

10. **`SyncIndicator` reused** — the status section uses the existing `SyncIndicator` component for consistent visual status display across screens.

**Key files:**
- `phpoc-web/src/components/screens/SyncSettings.jsx` — Complete rewrite (~500 lines)
- `phpoc-web/src/App.css` — ~160 lines of new sync styles (.sync-pill, .sync-pill-main, .sync-pill-details, .sync-pill-commitable, .sync-pill-not-commitable, .sync-commit-bar, etc.)
- `phpoc-web/src/context/DevModeContext.jsx` — `commitEntries()` now returns result

### 11.21 One-Off Task Toggle (2026-06-11)

**Problem:** The Dashboard's "Start New Task" form always creates timed, active tasks. Users need a quick way to log a completed task without starting/stopping it — e.g. "Read an article — 5 minutes ago" that should appear directly in the Sync screen as a stopped, commitable entry.

**Solution:** A small ☐ checkbox labeled "one-off" placed to the right of the Title input.

**Behavior:**
- **Unchecked (default):** Normal timed task. Button shows ▶ **Start**. `sync.capture({isActive: true})` → appears in Active Tasks pane.
- **Checked:** One-off task. Button shows ✓ **Log**. `sync.capture({isActive: false, endEpoch: Date.now()})` → captured as immediately ended (zero duration), appears directly in Sync screen as a stopped/commitable entry.

**Design decisions:**
1. **Checkbox location:** Next to the Title input in an inline flex row (`.title-input-group`) — avoids adding vertical height to the form.
2. **Visual feedback:** The checkbox label gets a yellow border + yellow-tinted background when checked (`:has(input:checked)`), matching the syncability yellow used on the Sync screen.
3. **Button label toggle:** "Start" → "Log" communicates the mode clearly. Icon switches from Play to Check.
4. **State reset:** `isOneOff` resets to `false` after submission so the next task defaults to timed.
5. **Data model:** A one-off task is just a regular staging entry with `is_active: false` and `end_epoch` equal to `start_epoch`. No special flag — it's indistinguishable from a manually stopped 0-duration task.

**Key files:**
- `phpoc-web/src/components/screens/Dashboard.jsx` — `isOneOff` state + checkbox + `handleStartTask` branches
- `phpoc-web/src/App.css` — `.title-input-group`, `.oneoff-checkbox-label`, `.oneoff-checkbox` styles
- `phpoc-web/src/components/ui/Icons.jsx` — Added `Check` icon

### 11.22 Full Ledger Export & Import Interface (2026-06-11)

**Problem:** The existing export (`exportLedger`) only exports staging entries — no committed blocks, no chain integrity. Import always did a full replace with no identity check. A full backup/restore workflow requires exporting the committed chain alongside staging entries.

**Solution:** New `exportLedgerFull()` function and genesis-aware import with merge placeholder.

#### Export (`ledger_export.js`)

```js
export async function exportLedgerFull(blocks, staging, crypto, masterKey)
```

**v2 export format:**
```json
{
  "format_version": "2",
  "exported_at": "2026-06-11T...",
  "ledger": [{ "type": "genesis", ... }, { "type": "day", ... }, ...],
  "staging": [{ "entry_id": "...", "title": "...", ... }, ...],
  "seal": "<HMAC of JSON.stringify({ledger, staging})>"
}
```

**Design decisions:**
1. **Pure read — never commits:** `exportLedgerFull` is a read-only operation. It serializes the current state of both the committed chain and staging entries without modifying anything.
2. **Seal covers {ledger, staging}:** The combined state is hashed — both arrays must validate together on import.
3. **Separate ledger/staging arrays:** Unlike v1 which conflated everything into `entries`, v2 keeps committed blocks and staging entries separate. This enables the import side to detect genesis identity and make merge decisions.
4. **Block hashes preserved as-is:** Chain integrity is maintained — `prev_hash` links, `day_hash`, entry hashes within blocks — all untouched.

**Test coverage:** 72 tests covering function existence, Blob/MIME type, v2 format structure, block/staging preservation, seal integrity (covers data not metadata), deterministic output, different-key-isolation, empty-data edge cases, staging-not-mutated guarantee, chain linkage verification, real mock ledger (97 blocks, 205 entries from user's data at `/tmp/phpoc-mock-ledger.json`), error handling (null/undefined/empty), v1/v2 format version differentiation, and large export (100 synthetic blocks).

#### Import (`ledger_import.js`)

**Updated return shape:**
```js
{
  entries: [...],           // staging entries to write
  count: number,
  genesisHash: string|null, // genesis day_hash (v2 only)
  formatVersion: "1"|"2"
}
```

**Seal verification adapts to format:**
- v1 → seal covers `JSON.stringify(entries)`
- v2 → seal covers `JSON.stringify({ledger, staging})`

**Genesis-aware import in DevModeContext:**

| Condition | Behavior |
|---|---|
| `genesisHash` is `null` (v1 file) | Replace (backward compat) |
| `genesisHash` ≠ existing | Replace (different identity) |
| `genesisHash` = existing | **Reject:** "This ledger shares your identity but merge is not yet supported" |

**Merge path is an open interface:** The `genesisHash = existing` branch is a single clear location where future merge reconciliation plugs in. When implemented, it will:
1. Decrypt `startTime_enc` from all entries in both divergent chains (requires master key)
2. Collect unique entries (no millisecond collisions expected for different human activities)
3. Sort by plaintext start time
4. Rebuild day blocks, re-seal, re-hash from fork point forward

**Bug fix:** Settings.jsx was calling `services.exportLedger()` / `services.importLedger()` but these functions are exposed at the top level of the context, not nested under `services`. Fixed by destructuring them directly from `useApp()`.

**Key files:**
- `phpoc-web/src/services/ledger_export.js` — Added `exportLedgerFull()` (v2 format)
- `phpoc-web/src/services/ledger_import.js` — Updated for v1/v2 dual-format, genesis extraction
- `phpoc-web/src/context/DevModeContext.jsx` — Genesis-aware import with merge stub
- `phpoc-web/src/components/screens/Settings.jsx` — Fixed export/import context path
- `phpoc-web/test/ledger_export_full_test.mjs` — 72 tests
- `phpoc-web/test/ledger_export_test.mjs` — 24 tests (v1, unchanged)
- `phpoc-web/test/ledger_import_test.mjs` — 26 tests (unchanged)

### 11.23 Import Security Analysis (2026-06-11)

**Question:** Is it possible to import a different ledger without destroying the existing one if the passphrase is wrong?

**Answer: Yes — passphrase verification gates all destructive operations.**

The import pipeline has five read-only validation gates before `storage.clear()` is ever called:

```
1. Parse JSON        → reject if invalid file
2. Seal verification  → reject if wrong passphrase/seed (HMAC mismatch)
3. Entry hash check   → reject if any entry hash doesn't match
4. Genesis check      → reject if same genesis (merge not supported)
5. [All pass]         → storage.clear() — first destructive operation
```

**Seal as passphrase gate:** `importLedger()` calls `crypto.verifySeal(sealPayload, seal, masterKey)`. The seal is HMAC-SHA256 derived from a sub-key of the Master Key. If the passphrase or seed is wrong → wrong Master Key → seal verification fails → `Error` thrown. No storage mutations occur.

**All 122 import/export tests pass** (26 import + 24 export + 72 full-export).

### 11.24 Staging Entry Portability Across Ledgers (2026-06-11)

**Question:** Can staging entries from one ledger be committed into a completely different ledger?

**Answer: Yes — staging entries are cryptographically portable.**

**Why:**
1. **Staging entries carry plaintext commit fields** at the outer level: `start_epoch`, `duration`, `title`, `tags`, `comment`, `pauses`. These are the source of truth for commit.
2. **`_encryptEntry()` reads plaintext, not ciphertext** — it extracts `data.start_epoch` directly and encrypts fresh with the current Master Key. It never calls `crypto.decrypt()` on `data.startTime_enc`.
3. **The genesis hash is not part of the entry hash** (confirmed against PHPSPEC §5.4). Entry hashes are computed from the entry's own data dict only. No genesis, no block hash, no `prev_hash`.
4. **Old encrypted fields are dead weight** — `data.startTime_enc = this.crypto.encrypt(...)` overwrites whatever was there from the previous ledger.

**Key derivation chain (per PHPSPEC §2):**
```
Passphrase → PBKDF2(passphrase, "session-salt", 600K) → PDK
PDK → AES-decrypt genesis.identity.recovery_seed_enc → Seed (32 bytes)
Seed → base64_decode → Master Key (32 bytes)
Master Key → HMAC-SHA256(MK, random_salt)[:16] → AES-128-CTR encryption key
```

Two different ledgers = two different seeds = two different Master Keys. But since commit reads plaintext and re-encrypts fresh, the staging entry is fungible.

**Implication for import workflow:** When importing a different ledger, uncommitted staging entries can be preserved and merged into the imported ledger's staging area with no cryptographic conflict. The only artifacts are semantic (another person's device UUIDs on the entries).

### 11.25 Known Bug — v2 Import Loses Committed Chain (2026-06-11)

**Problem:** `importLedger()` extracts `parsed.staging` as `result.entries` but never returns `parsed.ledger`. `importLedgerAction` writes only `ENTRIES_KEY` (staging entries) — never writes `ledger:blocks`.

**Impact:** After importing a v2 file with 97 committed blocks, the ledger chain is empty. The first `commitEntries()` call sees `[]` blocks and builds day blocks from scratch, losing the imported chain's entire history.

**Fix (planned):** `importLedger()` should also return `{ledger}` array. `importLedgerAction` should write it to `ledger:blocks` alongside `ENTRIES_KEY`.

### 11.26 Import Workflow Enhancement (Completed 2026-06-11)

Two safety gates added before the destructive `storage.clear()`:

**A. Destroy warning + export offer:**
- "The ledger currently in use will be destroyed. Export it first?"
- Calls `exportLedgerFull()` if user accepts before proceeding.

**B. Staging persistence option:**
- "You have N uncommitted entries (M active). Keep them staged after import?"
- If yes: read entries before `storage.clear()`, then merge into imported staging after write.
- If no: proceed with full wipe as currently implemented.

**C. UI Design (2026-06-11):**
- Warnings and checkboxes merged DIRECTLY into the form phase (no separate confirmation phase)
- `probeExistingData()` reads IndexedDB directly to check for existing `ledger:blocks` and `entries`
- Required "I understand" checkbox (red background) before Import button enables
- Optional "Keep N staging entries" checkbox (green background)
- "📤 Export current ledger" button before proceeding
- Applied to both Settings and Onboarding screens

### 11.27 History Calendar Widget + Committed Entry Decryption (2026-06-11)

**Problem:** The History screen used `<input type="date">` which only allows single-date filtering. Imported committed entries from `ledger:blocks` never appeared because `sync.getCompleted()` only read from staging.

**A. Custom Month Calendar Widget:**
Replaces the plain date input with an inline calendar component in `History.jsx`:
- **State:** `calendarYear`, `calendarMonth` — tracks which month is displayed
- **Navigation:** `◀◀`/`◀`/`▶`/`▶▶` buttons for year/month stepping
- **Day grid:** 7-column CSS grid (`grid-template-columns: repeat(7, 1fr)`) per week row
- **Entry dots:** Green dots on dates that have entries (computed via `datesWithEntries` Set)
- **Today:** Blue border ring
- **Selected date:** Blue filled background
- **Click behavior:** Toggle — click a day to filter, click selected day to clear
- **Shortcuts:** [Today] and [Clear date] buttons below the grid
- **Month label:** Click to show all entries (clear filter)
- **CSS:** `.history-calendar`, `.calendar-week`, `.calendar-day`, `.calendar-day-today`, `.calendar-day-selected`, `.calendar-day-has-entries`, `.calendar-day-dot`, `.calendar-actions`, `.history-tag-filter`

**B. Committed Entry Decryption:**
Imported committed entries are stored encrypted in `ledger:blocks`. Each entry's data has:
- `startTime_enc` — AES-128-CTR encrypted hex of the start epoch
- `endTime_enc` — AES-128-CTR encrypted hex of the end epoch
- `metadata_enc` — AES-128-CTR encrypted hex of JSON metadata

Unlike staging entries which use `plain:` prefixed plaintext values, committed block entries require actual decryption. New method `_rawCommittedEntryToDTO(rawEntry)` in `sync.js`:
- Calls `this._crypto.decryptWithCachedKey()` on each encrypted field
- Parses decrypted strings as integers/JSON
- Builds DTO with `committed: true`, `block_index`, and computed `date`
- Uses `rawEntry.hash` as `entry_id` (committed entries have no separate entry_id field)

`sync.getCompleted()` now:
1. Reads staging completed entries from `readEntries()` (as before)
2. Reads `ledger:blocks` from storage
3. Iterates all block entries → decrypts via `_rawCommittedEntryToDTO()` → marks committed
4. Returns `[...committedDTOs, ...stagingCompleted]` merged
5. Wraps block reading in try/catch — if master key isn't cached, staging entries still show

**Files changed:**
| File | Change |
|------|--------|
| `sync.js` | New `_rawCommittedEntryToDTO()` (58 lines). Extended `getCompleted()` to read + decrypt committed entries. |
| `History.jsx` | Calendar state + 100 lines of calendar compute/JSX. Entry `date` normalization from `start_epoch`. |
| `App.css` | ~100 lines of calendar CSS. |
