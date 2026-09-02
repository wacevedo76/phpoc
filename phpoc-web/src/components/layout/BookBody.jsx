/**
 * BookBody — content-swap helper (Commonplace Slice 3).
 *
 * Rendered as the `AppLayout` child in `App.jsx`. When the active book is
 * `commonplace`, it renders the `CommonplaceScreen`; otherwise it renders the
 * passed `ledgerScreen` node. The bottom-nav tabs are independent of book mode,
 * so switching books never resets the active tab (R6).
 */

import React from 'react';
import CommonplaceScreen from '../screens/CommonplaceScreen.jsx';
import CommonplaceSettingsScreen from '../screens/CommonplaceSettingsScreen.jsx';
import { useBookMode } from '../../commonplace/book_mode.jsx';

export default function BookBody({ ledgerScreen, commonplaceService, currentScreen = 'dashboard' }) {
  const { book } = useBookMode();

  if (book.key === 'commonplace') {
    // Only dashboard + settings swap to the Commonplace surface; every other
    // tab (history/tags/sync/profile) keeps the ledger node (S5).
    if (currentScreen === 'settings') {
      return <CommonplaceSettingsScreen service={commonplaceService} />;
    }
    if (currentScreen === 'dashboard') {
      return <CommonplaceScreen service={commonplaceService} />;
    }
    return ledgerScreen;
  }

  return ledgerScreen;
}
