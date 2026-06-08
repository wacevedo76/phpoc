# PH Ledger — React Web UI Design Decisions

> **Date:** 2026-06-08
> **Context:** Phase 1 (Web Prototype) of the cross-platform rollout. CLI reference implementation is complete at 1341 tests. The React web UI is the first graphical client, proving the interaction model before the Flutter mobile port.

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
