---
name: phpoc-web-vivaldi-restore
description: Automated Vivaldi-browser workflow for phpoc-web — start the Vite dev server, wipe browser storage (IndexedDB phpoc-db + localStorage), clean-build, read credentials from TEST_CREDENTIALS.md, and drive the "Connect to existing Worker" (Restore-from-Cloud) onboarding with agent_browser. Use when asked to run or test phpoc-web restore-from-cloud in the local Vivaldi browser.
---

# phpoc-web Vivaldi Restore-from-Cloud

Start server → wipe storage → clean build → creds → "Connect to existing Worker", driven with
`agent_browser` (browser executable `/usr/bin/vivaldi-stable`). Secrets come from
`TEST_CREDENTIALS.md` (repo root, gitignored) — never hardcode them here.

## 1. Start the dev server
```bash
cd phpoc-web && npx vite --host 0.0.0.0 --port 5173    # opens /?dev=false
```
Attach the browser: `open http://localhost:5173/?dev=false`. For a fresh launch add
`sessionMode:"fresh"` + `--executable-path "/usr/bin/vivaldi-stable"`. If Vivaldi already runs the
app, reuse its `localhost:5173` tab instead of opening a new one.

## 2. Wipe existing state
agent_browser `eval --stdin` (then `reload`):
```js
(async () => {
  const clear = (db, store) => new Promise(res => {
    const r = indexedDB.open(db);
    r.onsuccess = () => { try {
      const t = r.result.transaction(store, 'readwrite');
      t.objectStore(store).clear();
      t.oncomplete = () => { r.result.close(); res('ok:' + db); };
      t.onerror = () => { r.result.close(); res('err:' + db); };
    } catch { r.result.close(); res('nostore:' + db); } };
    r.onerror = () => res('openfail:' + db);
  });
  const out = [await clear('phpoc-db', 'phpoc-sync'),   // idb-keyval store (real storage)
               await clear('phpoc-sync', 'keyval')];    // legacy probe store
  localStorage.clear(); sessionStorage.clear();
  return out.join(',');
})()
```
After reload, `snapshot -i` should show the onboarding menu ("Welcome to PH Ledger").

## 3. Clean build
```bash
cd phpoc-web && npm install && npm run build
# full clean: rm -rf node_modules dist && npm install && npm run build
```
(Dev server serves source, not dist — this step is a clean-compile verification.)

## 4. Credentials
Read `TEST_CREDENTIALS.md` → "Quick Reference — Test Ledger" table (NOT the dev "Personal Ledger"
section). Set: `SEED` / `PASS` / `URL` / `KEY`.

## 5. Drive "Connect to existing Worker"
`snapshot -i` between steps; inputs have stable ids, buttons matched by role text.
1. Menu: `find role button --name "Connect to existing Worker" click`
2. `fill #worker-url <URL>`; `fill #worker-api-key <KEY>`; `find role button --name "Connect" click`
3. Wait for `#connect-passphrase` (step shows "✅ Genesis compatible"); then
   `fill #connect-passphrase <PASS>`; `fill #connect-seed <SEED>`; `find role button --name "Unlock" click`

## 6. Verify success (Dashboard)
Poll until the Dashboard's collapsed "Start New Task" bar appears (only rendered on the
Dashboard; `#task-title` does NOT exist until that form is expanded):
```js
document.querySelector('[aria-label="Expand new task form"]') ? 'SUCCESS' : 'pending'
```
(`eval --stdin`, or `snapshot -i` and look for the ACTIVE TASKS pane + Logout nav.)

## Notes
- Field ids: step 1 `#worker-url`, `#worker-api-key`; step 2 `#connect-passphrase`, `#connect-seed`.
- Success is the Dashboard (nav Home/History/Tags/Profile/Sync/Settings/Logout + "No active tasks"
  pane), NOT the unlock screen — unlike Flutter, whose success signal is the unlock screen. The
  "Unlocking ledger..." interstitial may last a few seconds (fetches the full 31-block chain).
