import React from 'react';

/**
 * LedgerSync — commit staged entries to the ledger chain (Phase 3).
 *
 * Placeholder for now. Will eventually show:
 *   - Pending entries ready for commit
 *   - Chain verification status
 *   - Commit button (creates day blocks, seals them, pushes to remote)
 *   - Block history view
 */
export default function LedgerSync() {
  return (
    <div className="screen">
      <div className="screen-header">
        <h2 className="screen-title">Ledger Sync</h2>
      </div>
      <div className="pane-empty" style={{ marginTop: '2rem' }}>
        <span className="pane-empty-icon">⛓️</span>
        <p>Ledger sync coming in Phase 3</p>
        <p className="pane-hint">
          This will commit staged entries to the block chain,
          seal them with HMAC, and push new blocks to the remote Worker.
        </p>
      </div>
    </div>
  );
}
