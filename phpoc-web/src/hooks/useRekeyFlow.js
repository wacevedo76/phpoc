/**
 * useRekeyFlow — shared recovery-seed re-key modal state + handlers.
 *
 * Both the ledger `Settings` screen and the Commonplace `CommonplaceSettingsScreen`
 * surface the same two-secret reveal-gate re-key dialog (C-2, option (a)): mint a
 * fresh recovery seed up front → require the user to save it + type it back → verify
 * the current passphrase → run `useApp().rekey({ oldPassphrase, newPassphrase, newSeed })`.
 *
 * This hook owns ALL of that state (the 9 useState slices previously duplicated
 * verbatim across the two screens) and exposes `open` / `cancel` / `confirm` plus the
 * setters a presentational `RekeyModal` needs. Dependencies are injected (not read from
 * context) so the hook is testable and both callers stay in control of their own
 * `useApp()` reads.
 *
 * @param {object} args
 * @param {Function|null} args.rekey - `useApp().rekey` (may be undefined in provider-less tests).
 * @param {Function|null} args.generateSeed - `services.crypto.generateSeed` (may be absent in tests).
 * @returns {object} re-key flow state + handlers (see `RekeyModal` props).
 */

import { useCallback, useState } from 'react';

export function useRekeyFlow({ rekey, generateSeed }) {
  const [show, setShow] = useState(false);
  const [oldPassphrase, setOldPassphrase] = useState('');
  const [newPassphrase, setNewPassphrase] = useState('');
  const [savedSeed, setSavedSeed] = useState(false);
  const [acknowledge, setAcknowledge] = useState(false);
  const [seedConfirm, setSeedConfirm] = useState('');
  const [newSeed, setNewSeed] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  /** Open the flow and mint the fresh seed up front (reveal-gate). */
  const open = useCallback(() => {
    setShow(true);
    setOldPassphrase('');
    setNewPassphrase('');
    setSavedSeed(false);
    setAcknowledge(false);
    setSeedConfirm('');
    setError('');
    setBusy(false);
    setDone(false);
    try {
      if (generateSeed && typeof generateSeed === 'function') {
        setNewSeed(generateSeed());
      } else {
        setNewSeed('');
        setError('Failed to generate a new recovery seed — crypto is not ready.');
      }
    } catch (err) {
      setNewSeed('');
      setError('Failed to generate a new recovery seed: ' + (err?.message || 'error'));
    }
  }, [generateSeed]);

  const cancel = useCallback(() => {
    setShow(false);
  }, []);

  /** Run the two-secret re-key; surfaces failures without closing the dialog. */
  const confirm = useCallback(async () => {
    if (typeof rekey !== 'function') {
      setError('Re-key is not available in this build.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await rekey({
        oldPassphrase,
        newPassphrase,
        newSeed,
      });
      setDone(true);
    } catch (err) {
      setError(err?.message || 'Re-key failed.');
    } finally {
      setBusy(false);
    }
  }, [rekey, oldPassphrase, newPassphrase, newSeed]);

  return {
    show,
    oldPassphrase,
    newPassphrase,
    savedSeed,
    acknowledge,
    seedConfirm,
    newSeed,
    error,
    busy,
    done,
    setOldPassphrase,
    setNewPassphrase,
    setSavedSeed,
    setAcknowledge,
    setSeedConfirm,
    open,
    cancel,
    confirm,
  };
}
