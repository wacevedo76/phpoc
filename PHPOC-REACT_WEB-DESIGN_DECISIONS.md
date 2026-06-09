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
| Dashboard | `Dashboard.jsx` | `ph view` + `ph add` | Main screen: active tasks + new task form |
| NewTask | `NewTask.jsx` | `ph add` | Standalone task creation (alternative entry) |
| History | `History.jsx` | `ph list` | Completed entries, grouped by day, filtered |
| Tags | `Tags.jsx` | `ph tags` | Tag list with frequency counts |
| SyncSettings | `SyncSettings.jsx` | `ph sync` | Sync status display, manual sync trigger |
| UserProfile | `UserProfile.jsx` | `ph login info` | Identity card, auth status, stats, gateway to config |
| Configuration | `Configuration.jsx` | `ph config` / CLI config file | All 27 CLI config fields across 9 sections |
| LedgerSync | `LedgerSync.jsx` | `ph sync --commit` | Phase 3 placeholder for block chain commit |
| Settings | `Settings.jsx` | App-level (dev toggle, about) | Developer mode toggle, remote config, about |

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
                  │       └─ form (title, tags, start)
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
                  │   ├─ SyncIndicator
                  │   ├─ Status detail rows
                  │   └─ Sync Now button
                  └─ <Settings />
                      ├─ Dev mode toggle
                      ├─ Remote URL + API key
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

### 11.11 Import/Export Design (2026-06-09)

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
3. Parse → validate `format_version`, `entries` array, `seal` presence
4. Passphrase prompt (modal overlay)
5. `crypto.verifySeal(entriesJson, seal, masterKey)` — **mismatch → reject entirely, show error**
6. Recompute each entry's `hash` and compare — **any mismatch → reject entirely, show error**
7. `sync._local.writeEntries(parsed.entries)` → replace all local entries
8. UI refreshes to show imported data

**File format:**
```json
{
  "format_version": "1",
  "exported_at": "2026-06-09T14:30:00.000Z",
  "entries": [ /* StagingEntry[] */ ],
  "seal": "abc123..."
}
```

- `entries` — the user's ledger data (staging entry DTOs). Device-agnostic, system-agnostic.
- `seal` — HMAC-SHA256 (PHPSPEC §5.2 `computeSeal`) of `JSON.stringify(entries)` only. Proves the ledger was exported by the same master key and hasn't been tampered with.
- `exported_at` — informational timestamp for user transparency (e.g. backup log display). Sits outside the seal. Not part of the ledger.
- `format_version` — allows format evolution (entries-only for now; could add ledger blocks in v2).

**Key decisions:**
- Ledger is defined as the entries array only — no cookie, no device identity, no app metadata
- File wrapper metadata (`exported_at`, `format_version`) sits outside the sealed region
- Import always overwrites (replaces) local entries — no merge
- Verification failure (seal or entry hash) → reject entirely, no partial import
- Active task flags (`is_active`, `is_paused`) preserved as-is on import

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

**Steps 1–5 are in-browser only** — zero server code required. Steps 6–9 layer on deployment options.

### 11.10 Current Status (2026-06-09)

| Step | Status | Notes |
|---|---|---|
| 1 — StoragePlugin interface | ✅ `StorageBackend`, `MemoryBackend`, `IndexedDBBackend`, `HttpBackend` exist | Config-driven factory not yet wired. `list(prefix)` added to StorageBackend. `delete()` added to HttpTransport + MockRemoteBackend. DELETE handler added to Worker. |
| 2 — MockRemoteBackend | ✅ Complete | 46 tests, 300 total across mock infra |
| 3 — Import/Export | ✅ Complete (83 tests) | `exportLedger(entries, crypto, masterKey)` → signed JSON Blob. `importLedger(file, crypto, masterKey)` → `{entries, count}`. `PassphraseModal.jsx` — reusable passphrase prompt overlay (reuses AuthScreen pattern). 3 test suites: 24 (export), 26 (import), 33 (modal). Auth-gated (passphrase → `crypto.authenticate()` → master key). Seal = HMAC-SHA256 of `JSON.stringify(entries)` only. Entry hash re-validation on import. Reject entirely on any failure. Settings screen wiring pending (Backup & Restore section). |
| 4 — Ledger engine JS port | ❌ Not started | Largest remaining work item |
| 5 — Staging CRUD | ⚠️ Partial | UI scaffold exists, wired to dummy data |
| 6 — Bridge server | ❌ Not started | |
| 7 — Dockerfile | ❌ Not started | |
| 8 — Multi-tenant Worker | ❌ Not started | |
| 9 — Real crypto | ❌ Not started | WASM binary exists, needs web integration |
