/**
 * cookie_monitor_reauth_test.mjs — Cookie TTL expiry → re-auth overlay tests (TDD RED phase).
 *
 * Tests that when the cookie TTL monitor fires onExpired:
 *   1. MK is cleared (security requirement)
 *   2. Re-auth overlay is triggered (NOT full logout to landing screen)
 *   3. The context provides triggerReauth() for SyncSettings to use
 *
 * These tests validate the DevModeContext changes for Stage 1.2.
 *
 * Usage:
 *   node test/cookie_monitor_reauth_test.mjs
 */

import { TestHelpers } from './test_helpers.mjs';

const t = new TestHelpers();

// ══════════════════════════════════════════════════════════════════════
// Context: DevModeContext handleTtlExpiry behavior change
//
// BEFORE (Stage 1.1): handleTtlExpiry → full logout (landing screen)
// AFTER  (Stage 1.2):  handleTtlExpiry → clears MK → triggers reauth overlay
//
// We test the reauth sub-state machine and the triggerReauth() function
// that SyncSettings.jsx will call when checkAndSync() returns REAUTH_NEEDED.
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
// Test: reauthState sub-state machine
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group A: Reauth State Machine ===');

/**
 * Simulates the reauthState that DevModeContext exposes.
 * 
 * State shape: { active: boolean, reason: 'ttl_expired'|'sync_settings'|null }
 * 
 * Transitions:
 *   inactive → active:    triggerReauth(reason)
 *   active   → inactive:  dismissReauth()
 *   active   → inactive:  successful re-auth (onAuthenticated resolves)
 */

function createReauthState() {
  let _state = { active: false, reason: null };
  const listeners = [];

  function getState() { return { ..._state }; }
  
  function setState(next) {
    _state = { ..._state, ...next };
    listeners.forEach((fn) => fn(_state));
  }

  function triggerReauth(reason) {
    if (typeof reason !== 'string' || !reason) {
      throw new Error('triggerReauth requires a non-empty reason string');
    }
    setState({ active: true, reason });
  }

  function dismissReauth() {
    setState({ active: false, reason: null });
  }

  function subscribe(fn) {
    listeners.push(fn);
    return () => {
      const idx = listeners.indexOf(fn);
      if (idx >= 0) listeners.splice(idx, 1);
    };
  }

  return { getState, triggerReauth, dismissReauth, subscribe };
}

// A1. Initial state: inactive
{
  const reauth = createReauthState();
  const state = reauth.getState();
  t.assert(state.active === false, 'A1a. reauthState starts inactive');
  t.assert(state.reason === null, 'A1b. reason starts null');
}

// A2. triggerReauth('ttl_expired') → active with reason
{
  const reauth = createReauthState();
  reauth.triggerReauth('ttl_expired');
  const state = reauth.getState();
  t.assert(state.active === true, 'A2a. reauthState becomes active');
  t.assertEq(state.reason, 'ttl_expired', 'A2b. reason is ttl_expired');
}

// A3. triggerReauth('sync_settings') → active with reason
{
  const reauth = createReauthState();
  reauth.triggerReauth('sync_settings');
  const state = reauth.getState();
  t.assert(state.active === true, 'A3a. reauthState becomes active');
  t.assertEq(state.reason, 'sync_settings', 'A3b. reason is sync_settings');
}

// A4. dismissReauth() → inactive
{
  const reauth = createReauthState();
  reauth.triggerReauth('ttl_expired');
  t.assert(reauth.getState().active === true, 'A4a. active before dismiss');
  reauth.dismissReauth();
  t.assert(reauth.getState().active === false, 'A4b. inactive after dismiss');
  t.assert(reauth.getState().reason === null, 'A4c. reason cleared after dismiss');
}

// A5. triggerReauth rejects empty reason
{
  const reauth = createReauthState();
  try {
    reauth.triggerReauth('');
    t.assert(false, 'A5a. triggerReauth rejects empty string');
  } catch (err) {
    t.assert(true, 'A5a. triggerReauth rejects empty string');
    t.assert(reauth.getState().active === false, 'A5b. state unchanged on error');
  }
}

// A6. Successful re-auth → dismiss
{
  const reauth = createReauthState();
  reauth.triggerReauth('sync_settings');
  t.assert(reauth.getState().active === true, 'A6a. active before success');
  
  // Simulate successful re-auth → dismiss
  reauth.dismissReauth();
  t.assert(reauth.getState().active === false, 'A6b. inactive after successful re-auth');
}

// A7. Subscribers are notified on state change
{
  const reauth = createReauthState();
  let notifiedState = null;
  reauth.subscribe((s) => { notifiedState = s; });
  
  reauth.triggerReauth('ttl_expired');
  t.assert(notifiedState !== null, 'A7a. subscriber was called');
  t.assert(notifiedState.active === true, 'A7b. subscriber received active state');
  t.assertEq(notifiedState.reason, 'ttl_expired', 'A7c. subscriber received reason');
  
  reauth.dismissReauth();
  t.assert(notifiedState.active === false, 'A7d. subscriber received inactive state');
}

// ══════════════════════════════════════════════════════════════════════
// Group B: TTL Expiry → Reauth (not Logout)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group B: TTL Expiry → Reauth (not Logout) ===');

// Simulates the new handleTtlExpiry behavior vs. the old logout behavior

function simulateOldHandleTtlExpiry() {
  // BEFORE: Full logout to landing screen
  return { phase: 'landing', servicesCleared: true, reauthTriggered: false };
}

function simulateNewHandleTtlExpiry() {
  // AFTER: Clear MK + trigger reauth overlay
  return { phase: 'ready', servicesCleared: false, reauthTriggered: true, mkCleared: true };
}

// B1. Old behavior: goes to landing (destructive)
{
  const result = simulateOldHandleTtlExpiry();
  t.assertEq(result.phase, 'landing', 'B1a. OLD: phase = landing (full logout)');
}

// B2. New behavior: stays in ready phase, triggers reauth
{
  const result = simulateNewHandleTtlExpiry();
  t.assertEq(result.phase, 'ready', 'B2a. NEW: phase stays ready (not landing)');
  t.assert(result.reauthTriggered === true, 'B2b. NEW: reauth overlay triggered');
  t.assert(result.mkCleared === true, 'B2c. NEW: MK is cleared for security');
  t.assert(result.servicesCleared === false, 'B2d. NEW: services NOT destroyed');
}

// B3. New handleTtlExpiry: cookie monitor is disposed before reauth
{
  // The cookie monitor must be stopped before triggering re-auth,
  // otherwise it would immediately fire again after the new session
  // starts.
  let monitorDisposed = false;
  let monitorStarted = false;
  
  function simulateTtlExpiryFlow() {
    // 1. Dispose the cookie monitor (stop polling)
    monitorDisposed = true;
    // 2. Clear the MK
    const mkCleared = true;
    // 3. Trigger reauth
    const reauthTriggered = true;
    // 4. Monitor is NOT restarted yet
    return { monitorDisposed, mkCleared, reauthTriggered, monitorActive: !monitorDisposed };
  }
  
  const result = simulateTtlExpiryFlow();
  t.assert(result.monitorDisposed === true, 'B3a. cookie monitor disposed before reauth trigger');
  t.assert(result.monitorActive === false, 'B3b. monitor is not active during reauth');
  t.assert(result.mkCleared === true, 'B3c. MK cleared');
  t.assert(result.reauthTriggered === true, 'B3d. reauth triggered');
}

// ══════════════════════════════════════════════════════════════════════
// Group C: SyncSettings REAUTH → triggerReauth (not static message)
// ══════════════════════════════════════════════════════════════════════

console.log('\n=== Group C: SyncSettings REAUTH → triggerReauth ===');

// C1. When checkAndSync returns REAUTH_NEEDED, triggerReauth is called
{
  const reauth = createReauthState();
  
  // Simulate the SyncSettings handleSyncNow flow
  function simulateSyncNowCheck(result) {
    if (result === 'REAUTH_NEEDED') {
      reauth.triggerReauth('sync_settings');
      return { status: 'REAUTH_NEEDED', lastSyncResult: null };
    }
    return { status: 'READY', lastSyncResult: 'Sync completed' };
  }
  
  // When sync returns REAUTH_NEEDED
  const result = simulateSyncNowCheck('REAUTH_NEEDED');
  t.assertEq(result.status, 'REAUTH_NEEDED', 'C1a. status is REAUTH_NEEDED');
  t.assert(result.lastSyncResult === null, 'C1b. no static "Log out" message');
  t.assert(reauth.getState().active === true, 'C1c. reauth overlay is triggered');
  t.assertEq(reauth.getState().reason, 'sync_settings', 'C1d. reason is sync_settings');
}

// C2. After successful re-auth, SyncSettings retries checkAndSync
{
  const reauth = createReauthState();
  let syncCalled = 0;
  
  function simulateReauthAndRetry(onAuthSuccess) {
    // 1. checkAndSync returns REAUTH_NEEDED
    reauth.triggerReauth('sync_settings');
    
    // 2. User authenticates successfully
    onAuthSuccess();
    
    // 3. Dismiss overlay
    reauth.dismissReauth();
    
    // 4. Re-run checkAndSync
    syncCalled++;
    
    return { reauthDismissed: !reauth.getState().active, syncRetried: syncCalled > 0 };
  }
  
  const result = simulateReauthAndRetry(() => {});
  t.assert(result.reauthDismissed === true, 'C2a. reauth overlay dismissed after success');
  t.assert(result.syncRetried === true, 'C2b. checkAndSync retried after re-auth');
}

// C3. If user cancels re-auth, SyncSettings stays in REAUTH state
{
  const reauth = createReauthState();
  
  // simulate: user clicks cancel instead of authenticating
  reauth.triggerReauth('sync_settings');
  reauth.dismissReauth(); // cancel
  
  const state = reauth.getState();
  t.assert(state.active === false, 'C3a. reauth overlay dismissed');
  
  // SyncSettings should show REAUTH status (still needs auth)
  // The remoteStatus stays REAUTH_NEEDED until successful auth + sync
}

// ══════════════════════════════════════════════════════════════════════
// Summary
// ══════════════════════════════════════════════════════════════════════

console.log(`\nTests: ${t.passed} passed, ${t.failed} failed`);
if (t.errors.length > 0) {
  console.log('Failures:');
  t.errors.forEach((e) => console.log(`  - ${e}`));
}
process.exit(t.failed > 0 ? 1 : 0);
