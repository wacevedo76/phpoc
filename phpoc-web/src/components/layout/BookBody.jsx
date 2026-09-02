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
import { useBookMode } from '../../commonplace/book_mode.jsx';

export default function BookBody({ ledgerScreen, commonplaceService }) {
  const { book } = useBookMode();

  if (book.key === 'commonplace') {
    return <CommonplaceScreen service={commonplaceService} />;
  }

  return ledgerScreen;
}
