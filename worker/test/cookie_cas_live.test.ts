/**
 * worker/test/cookie_cas_live.test.ts — Worker cookie CAS route (Phase 2: RED).
 *
 * Live HTTP integration tests for the device-cookie stale-write CAS guard
 * (ADR-034 §3a / I8) wired into the generic blob PUT handler. The Worker must
 * apply CAS ONLY to the `staging/blobs/device_cookie.bin` path (suffix match);
 * every other blob PUT stays a blind pass-through.
 *
 * Phase 2 (RED): the deployed test Worker has no CAS guard yet — J7 will
 * return 200 instead of the expected 409. Run AFTER `npx wrangler deploy
 * -c wrangler.testing.toml` (Phase 3) to see the real behavior.
 *
 * Blueprint: docs/planning/STAGING_COOKIE_CAS_PHASE1.md (Group J: J6–J10)
 *
 * Run: cd worker && PHPOC_API_KEY=… npx vitest run test/cookie_cas_live.test.ts
 */

import { describe, it, expect, afterAll } from 'vitest';

// ── Constants ────────────────────────────────────────────────────────────

const WORKER_URL = 'https://phpoc-staging-testing.wacevedo.workers.dev';
const API_KEY = process.env.PHPOC_API_KEY || '';
const API_KEY_HEADER = 'X-Api-Key';

if (!API_KEY) {
  throw new Error('PHPOC_API_KEY environment variable is required for tests. Set it before running: PHPOC_API_KEY="your-key" npx vitest run');
}

// Test prefix ensures no collision with real data or other test runs.
const TEST_PREFIX = `_vitest_cas_${Date.now()}_${Math.random().toString(36).slice(2, 8)}/`;

// ── Helpers ──────────────────────────────────────────────────────────────

/** A cookie blob path scoped to this test case; still ends in
 *  `staging/blobs/device_cookie.bin` so the Worker's suffix-match CAS fires. */
function cookiePath(scope: string): string {
  return `${TEST_PREFIX}${scope}/staging/blobs/device_cookie.bin`;
}

function otherPath(scope: string): string {
  return `${TEST_PREFIX}${scope}/staging/blobs/other.bin`;
}

async function put(path: string, body: string): Promise<Response> {
  const headers: Record<string, string> = {
    [API_KEY_HEADER]: API_KEY,
    'Content-Type': 'application/json',
  };
  return fetch(`${WORKER_URL}/${path}`, {
    method: 'PUT',
    headers,
    body: new TextEncoder().encode(body),
  });
}

async function listFiles(prefix: string): Promise<Response> {
  return fetch(`${WORKER_URL}/?prefix=${encodeURIComponent(prefix)}`, {
    method: 'GET',
    headers: { [API_KEY_HEADER]: API_KEY },
  });
}

async function del(path: string): Promise<Response> {
  return fetch(`${WORKER_URL}/${path}`, {
    method: 'DELETE',
    headers: { [API_KEY_HEADER]: API_KEY },
  });
}

function cookieBody(seq: number | undefined, stagingHash: string = 'h'.repeat(64)): string {
  return JSON.stringify({
    device_uuid: 'test-device-cas',
    device_specifier: 'a'.repeat(32),
    staging_hash: stagingHash,
    ...(seq === undefined ? {} : { seq }),
  });
}

// ── Cleanup ──────────────────────────────────────────────────────────────

afterAll(async () => {
  const listed = await listFiles(TEST_PREFIX);
  if (listed.ok) {
    const files: string[] = await listed.json();
    await Promise.all(files.map((f) => del(`${TEST_PREFIX}${f}`).catch(() => {})));
  }
});

// ── Suite ────────────────────────────────────────────────────────────────

describe('Worker cookie CAS route (J6–J10)', () => {
  it('J6: PUT cookie seq=5 then seq=6 → both 200', async () => {
    const path = cookiePath('j6');
    const r1 = await put(path, cookieBody(5));
    expect(r1.status).toBe(200);
    const r2 = await put(path, cookieBody(6));
    expect(r2.status).toBe(200);
  });

  it('J7: PUT cookie seq=5 then seq=5 (and seq=4) → 409', async () => {
    const path = cookiePath('j7');
    const base = await put(path, cookieBody(5));
    expect(base.status).toBe(200);

    const replay = await put(path, cookieBody(5));
    expect(replay.status).toBe(409);

    const stale = await put(path, cookieBody(4));
    expect(stale.status).toBe(409);
  });

  it('J8: legacy cookie (no seq) after a seq=5 cookie → 200 (last-write-wins)', async () => {
    const path = cookiePath('j8');
    const base = await put(path, cookieBody(5));
    expect(base.status).toBe(200);

    const legacy = await put(path, cookieBody(undefined));
    expect(legacy.status).toBe(200);
  });

  it('J9: non-cookie blob PUT → always 200, no CAS', async () => {
    const path = otherPath('j9');
    const r = await put(path, JSON.stringify({ hello: 'world' }));
    expect(r.status).toBe(200);
  });

  it('J10: malformed JSON cookie body → 200 (treated as legacy)', async () => {
    const path = cookiePath('j10');
    const r = await put(path, '{ not valid json');
    expect(r.status).toBe(200);
  });
});
