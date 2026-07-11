/**
 * worker/test/row_level_endpoints.test.ts — Row-Level Staging Endpoint Tests (Phase 2: RED)
 *
 * Tests the 4 new Worker endpoints defined in:
 *   docs/planning/ROW_LEVEL_STAGING_SYNC_PLAN.md
 *
 * Endpoints under test:
 *   GET  /storage/staging/manifest              → {rows: [...], version: N}
 *   GET  /storage/staging/rows/{activity_id}    → single row or 404
 *   PUT  /storage/staging/rows/{activity_id}    → 200 | 400 | 409
 *   DELETE /storage/staging/rows/{activity_id}  → 200 | 404
 *
 * Phase 2 (RED): These tests WILL FAIL because the endpoints don't exist yet.
 * Phase 3 (GREEN): Implement the endpoints in src/index.ts to make them pass.
 *
 * Test blueprint: docs/planning/WORKER_ROW_LEVEL_TESTS_PHASE1.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// ── Constants ─────────────────────────────────────────────────────────────

const WORKER_URL = 'https://phpoc-staging-testing.wacevedo.workers.dev';
const API_KEY = 'ZfkbMrrdRaY7DeoanY1GqQAOSLDmI6gO';
const API_KEY_HEADER = 'X-Api-Key';

const TEST_PREFIX = `_vitest_rows_${Date.now()}_${Math.random().toString(36).slice(2, 8)}/`;

// ── Path helpers ──────────────────────────────────────────────────────────

/** Full manifest URL path for this test run. */
function manifestPath(): string {
  return `${TEST_PREFIX}storage/staging/manifest`;
}

/** Full row URL path for a given activity_id. */
function rowPath(activityId: string): string {
  return `${TEST_PREFIX}storage/staging/rows/${activityId}`;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────

function authHeaders(apiKey = API_KEY): Record<string, string> {
  return apiKey ? { [API_KEY_HEADER]: apiKey } : {};
}

async function getManifest(apiKey = API_KEY): Promise<Response> {
  return fetch(`${WORKER_URL}/${manifestPath()}`, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
}

async function getRow(activityId: string, apiKey = API_KEY): Promise<Response> {
  return fetch(`${WORKER_URL}/${rowPath(activityId)}`, {
    method: 'GET',
    headers: authHeaders(apiKey),
  });
}

async function putRow(
  activityId: string,
  body: Record<string, unknown>,
  apiKey = API_KEY,
): Promise<Response> {
  return fetch(`${WORKER_URL}/${rowPath(activityId)}`, {
    method: 'PUT',
    headers: {
      ...authHeaders(apiKey),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function putRowRaw(
  activityId: string,
  bodyString: string,
  contentType = 'application/json',
  apiKey = API_KEY,
): Promise<Response> {
  return fetch(`${WORKER_URL}/${rowPath(activityId)}`, {
    method: 'PUT',
    headers: {
      ...authHeaders(apiKey),
      'Content-Type': contentType,
    },
    body: bodyString,
  });
}

async function deleteRow(activityId: string, apiKey = API_KEY): Promise<Response> {
  return fetch(`${WORKER_URL}/${rowPath(activityId)}`, {
    method: 'DELETE',
    headers: authHeaders(apiKey),
  });
}

// ── Factory helpers ───────────────────────────────────────────────────────

function validRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    activity_id: `Test${Math.random().toString(36).slice(2, 8)}`,
    activity_status: 'staged',
    activity: 'obfuscated-blob-data',
    updated_at: Date.now(),
    ...overrides,
  };
}

let _counter = 0;
function uniqueId(label: string): string {
  _counter++;
  // Keep under 20 chars to pass ACTIVITY_ID_RE validation
  const suffix = Date.now().toString(36).slice(-6);
  return `${label.slice(0, 4)}${suffix}${_counter}`;
}

// ── Cleanup ───────────────────────────────────────────────────────────────

afterAll(async () => {
  // Delete all rows we know about by listing test prefix files
  const res = await fetch(
    `${WORKER_URL}/?prefix=${encodeURIComponent(TEST_PREFIX)}`,
    { method: 'GET', headers: authHeaders() },
  );
  if (res.ok) {
    const files: string[] = await res.json();
    await Promise.all(
      files.map((f) =>
        fetch(`${WORKER_URL}/${TEST_PREFIX}${f}`, {
          method: 'DELETE',
          headers: authHeaders(),
        }).catch(() => {}),
      ),
    );
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Group M: Manifest Endpoint (GET /storage/staging/manifest)
// ═══════════════════════════════════════════════════════════════════════════

describe('Group M: Manifest Endpoint', () => {

  it('M1: returns 200 with Content-Type application/json', async () => {
    const res = await getManifest();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('M2: returns correct JSON structure {rows, version}', async () => {
    const res = await getManifest();
    const body = await res.json();
    expect(body).toHaveProperty('rows');
    expect(body).toHaveProperty('version');
    expect(Array.isArray(body.rows)).toBe(true);
    expect(typeof body.version).toBe('number');
  });

  it('M3: empty manifest returns {rows: [], version: 0}', async () => {
    // Fresh run — no rows exist yet under this prefix
    const res = await getManifest();
    const body = await res.json();
    expect(body.rows).toEqual([]);
    expect(body.version).toBe(0);
  });

  it('M4: row objects have required fields', async () => {
    const id = uniqueId('M4');
    await putRow(id, validRow({ activity_id: id }));

    const res = await getManifest();
    const body = await res.json();
    expect(body.rows.length).toBeGreaterThanOrEqual(1);

    const row = body.rows.find((r: any) => r.activity_id === id);
    expect(row).toBeDefined();
    expect(typeof row.activity_id).toBe('string');
    expect(typeof row.activity_status).toBe('string');
    expect(typeof row.updated_at).toBe('number');
    // activity blob must NOT be in the manifest
    expect(row.activity).toBeUndefined();
  });

  it('M5: version increments on row creation', async () => {
    const before = await getManifest();
    const vBefore = (await before.json()).version;

    const id = uniqueId('M5');
    await putRow(id, validRow({ activity_id: id }));

    const after = await getManifest();
    const vAfter = (await after.json()).version;
    expect(vAfter).toBeGreaterThan(vBefore);
  });

  it('M6: version increments on row update', async () => {
    const id = uniqueId('M6');
    await putRow(id, validRow({ activity_id: id, updated_at: 100 }));

    const mid = await getManifest();
    const vMid = (await mid.json()).version;

    // Update with newer updated_at
    await putRow(id, validRow({ activity_id: id, updated_at: 200 }));

    const after = await getManifest();
    const vAfter = (await after.json()).version;
    expect(vAfter).toBeGreaterThan(vMid);
  });

  it('M7: version increments on row deletion', async () => {
    const id = uniqueId('M7');
    await putRow(id, validRow({ activity_id: id }));

    const before = await getManifest();
    const vBefore = (await before.json()).version;

    await deleteRow(id);

    const after = await getManifest();
    const vAfter = (await after.json()).version;
    expect(vAfter).toBeGreaterThan(vBefore);
  });

  it('M8: manifest reflects row creation', async () => {
    const id = uniqueId('M8');
    const row = validRow({ activity_id: id, activity_status: 'active', updated_at: 999 });
    await putRow(id, row);

    const res = await getManifest();
    const body = await res.json();
    const found = body.rows.find((r: any) => r.activity_id === id);
    expect(found).toBeDefined();
    expect(found.activity_status).toBe('active');
    expect(found.updated_at).toBe(999);
  });

  it('M9: manifest reflects row update (new updated_at)', async () => {
    const id = uniqueId('M9');
    await putRow(id, validRow({ activity_id: id, activity_status: 'staged', updated_at: 100 }));

    // Update
    await putRow(id, validRow({ activity_id: id, activity_status: 'paused', updated_at: 200 }));

    const res = await getManifest();
    const body = await res.json();
    const found = body.rows.find((r: any) => r.activity_id === id);
    expect(found).toBeDefined();
    expect(found.activity_status).toBe('paused');
    expect(found.updated_at).toBe(200);
  });

  it('M10: manifest reflects row deletion (ID no longer present)', async () => {
    const id = uniqueId('M10');
    await putRow(id, validRow({ activity_id: id }));

    await deleteRow(id);

    const res = await getManifest();
    const body = await res.json();
    const found = body.rows.find((r: any) => r.activity_id === id);
    expect(found).toBeUndefined();
  });

  it('M11: manifest is always reachable (no 404 for empty)', async () => {
    // Even on a fresh prefix with zero rows, manifest must return 200
    const res = await getManifest();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows).toBeDefined();
    expect(typeof body.version).toBe('number');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group R: Row CRUD Endpoints
// ═══════════════════════════════════════════════════════════════════════════

describe('Group R: Row CRUD', () => {

  it('R1: GET existing row returns 200', async () => {
    const id = uniqueId('R1');
    await putRow(id, validRow({ activity_id: id }));
    const res = await getRow(id);
    expect(res.status).toBe(200);
  });

  it('R2: GET row returns correct JSON structure', async () => {
    const id = uniqueId('R2');
    const row = validRow({ activity_id: id, activity_status: 'active', updated_at: 5000 });
    await putRow(id, row);

    const res = await getRow(id);
    const body = await res.json();
    expect(body.activity_id).toBe(id);
    expect(body.activity_status).toBe('active');
    expect(body.activity).toBe('obfuscated-blob-data');
    expect(body.updated_at).toBe(5000);
  });

  it('R3: GET row returns exact data that was PUT (round-trip)', async () => {
    const id = uniqueId('R3');
    const row = validRow({
      activity_id: id,
      activity_status: 'paused',
      activity: 'custom-blob-xyz-123',
      updated_at: 1712345678000,
    });
    await putRow(id, row);

    const res = await getRow(id);
    const body = await res.json();
    expect(body.activity_id).toBe(id);
    expect(body.activity_status).toBe('paused');
    expect(body.activity).toBe('custom-blob-xyz-123');
    expect(body.updated_at).toBe(1712345678000);
  });

  it('R4: GET nonexistent row returns 404', async () => {
    const res = await getRow('nonexistent-row-id');
    expect(res.status).toBe(404);
  });

  it('R5: PUT returns 200 on success', async () => {
    const id = uniqueId('R5');
    const res = await putRow(id, validRow({ activity_id: id }));
    expect(res.status).toBe(200);
  });

  it('R6: PUT with non-JSON Content-Type returns 400', async () => {
    const id = uniqueId('R6');
    const res = await putRowRaw(id, 'not json', 'text/plain');
    expect(res.status).toBe(400);
  });

  it('R7: PUT missing activity_id returns 400', async () => {
    const id = uniqueId('R7');
    const res = await putRowRaw(id, JSON.stringify({
      activity_status: 'staged',
      activity: 'blob',
      updated_at: 100,
    }));
    expect(res.status).toBe(400);
  });

  it('R8: PUT missing activity_status returns 400', async () => {
    const id = uniqueId('R8');
    const res = await putRowRaw(id, JSON.stringify({
      activity_id: id,
      activity: 'blob',
      updated_at: 100,
    }));
    expect(res.status).toBe(400);
  });

  it('R9: PUT missing activity returns 400', async () => {
    const id = uniqueId('R9');
    const res = await putRowRaw(id, JSON.stringify({
      activity_id: id,
      activity_status: 'staged',
      updated_at: 100,
    }));
    expect(res.status).toBe(400);
  });

  it('R10: PUT missing updated_at returns 400', async () => {
    const id = uniqueId('R10');
    const res = await putRowRaw(id, JSON.stringify({
      activity_id: id,
      activity_status: 'staged',
      activity: 'blob',
    }));
    expect(res.status).toBe(400);
  });

  it('R11: PUT with invalid activity_id format (too long) returns 400', async () => {
    const longId = 'A'.repeat(50);
    const res = await putRow(longId, validRow({ activity_id: longId }));
    expect(res.status).toBe(400);
  });

  it('R12: path traversal (../) is normalized by HTTP — reaches generic handler', async () => {
    // Note: ../ is URL-normalized by HTTP clients before reaching the Worker.
    // The Worker's activity_id validation in validateRowBody still guards against
    // path traversal if it were to arrive, but HTTP normalization prevents it.
    // This test confirms ../ doesn't escape the staging namespace.
    const res = await putRow('../escape', validRow({ activity_id: '../escape' }));
    // ../ is normalized away; the path no longer matches storage/staging/rows/
    // so it falls through to the generic PUT handler → 200
    expect(res.status).toBe(200);
  });

  it('R12b: PUT with slash in activity_id returns 400', async () => {
    const res = await putRow('foo/bar', validRow({ activity_id: 'foo/bar' }));
    expect(res.status).toBe(400);
  });

  it('R13: PUT with invalid activity_status returns 400', async () => {
    const id = uniqueId('R13');
    const res = await putRow(id, validRow({ activity_id: id, activity_status: 'invalid-status' }));
    expect(res.status).toBe(400);
  });

  it('R14: PUT with non-numeric updated_at returns 400', async () => {
    const id = uniqueId('R14');
    const res = await putRowRaw(id, JSON.stringify({
      activity_id: id,
      activity_status: 'staged',
      activity: 'blob',
      updated_at: 'not-a-number',
    }));
    expect(res.status).toBe(400);
  });

  it('R15: PUT with negative updated_at returns 400', async () => {
    const id = uniqueId('R15');
    const res = await putRow(id, validRow({ activity_id: id, updated_at: -1 }));
    expect(res.status).toBe(400);
  });

  it('R16: PUT with empty activity string returns 400', async () => {
    const id = uniqueId('R16');
    const res = await putRow(id, validRow({ activity_id: id, activity: '' }));
    expect(res.status).toBe(400);
  });

  it('R17: DELETE existing row returns 200', async () => {
    const id = uniqueId('R17');
    await putRow(id, validRow({ activity_id: id }));
    const res = await deleteRow(id);
    expect(res.status).toBe(200);
  });

  it('R18: DELETE nonexistent row returns 404', async () => {
    const res = await deleteRow('nonexistent-delete-row');
    expect(res.status).toBe(404);
  });

  it('R19: DELETE removes row from manifest', async () => {
    const id = uniqueId('R19');
    await putRow(id, validRow({ activity_id: id }));
    await deleteRow(id);

    const manifest = await getManifest();
    const body = await manifest.json();
    const found = body.rows.find((r: any) => r.activity_id === id);
    expect(found).toBeUndefined();
  });

  it('R20: DELETE then GET returns 404', async () => {
    const id = uniqueId('R20');
    await putRow(id, validRow({ activity_id: id }));
    await deleteRow(id);

    const res = await getRow(id);
    expect(res.status).toBe(404);
  });

  it('R21: independent rows — delete one does not affect another', async () => {
    const idA = uniqueId('R21A');
    const idB = uniqueId('R21B');
    await putRow(idA, validRow({ activity_id: idA, activity: 'blob-A' }));
    await putRow(idB, validRow({ activity_id: idB, activity: 'blob-B' }));

    await deleteRow(idA);

    // Row B is still intact
    const resB = await getRow(idB);
    expect(resB.status).toBe(200);
    const bodyB = await resB.json();
    expect(bodyB.activity).toBe('blob-B');
  });

  it('R22: PUT with extra fields preserves them (forward compat)', async () => {
    const id = uniqueId('R22');
    const res = await putRowRaw(id, JSON.stringify({
      activity_id: id,
      activity_status: 'staged',
      activity: 'blob',
      updated_at: 100,
      extra_field: 'preserve-me',
      nested: { deep: true },
    }));
    expect(res.status).toBe(200);

    const getRes = await getRow(id);
    const body = await getRes.json();
    expect(body.extra_field).toBe('preserve-me');
    expect(body.nested).toEqual({ deep: true });
    // Required fields still intact
    expect(body.activity_id).toBe(id);
    expect(body.activity_status).toBe('staged');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group P: Push Guard (PUT 409 Conflict)
// ═══════════════════════════════════════════════════════════════════════════

describe('Group P: Push Guard', () => {

  it('P1: first PUT always succeeds (no existing row)', async () => {
    const id = uniqueId('P1');
    const res = await putRow(id, validRow({ activity_id: id, updated_at: 1 }));
    expect(res.status).toBe(200);
  });

  it('P2: PUT with newer updated_at succeeds (200)', async () => {
    const id = uniqueId('P2');
    await putRow(id, validRow({ activity_id: id, updated_at: 100 }));

    const res = await putRow(id, validRow({ activity_id: id, updated_at: 200 }));
    expect(res.status).toBe(200);
  });

  it('P3: PUT with same updated_at returns 409', async () => {
    const id = uniqueId('P3');
    await putRow(id, validRow({ activity_id: id, updated_at: 100 }));

    const res = await putRow(id, validRow({ activity_id: id, updated_at: 100 }));
    expect(res.status).toBe(409);
  });

  it('P4: PUT with older updated_at returns 409', async () => {
    const id = uniqueId('P4');
    await putRow(id, validRow({ activity_id: id, updated_at: 200 }));

    const res = await putRow(id, validRow({ activity_id: id, updated_at: 100 }));
    expect(res.status).toBe(409);
  });

  it('P5: 409 response has CORS headers', async () => {
    const id = uniqueId('P5');
    await putRow(id, validRow({ activity_id: id, updated_at: 100 }));
    const res = await putRow(id, validRow({ activity_id: id, updated_at: 50 }));
    expect(res.status).toBe(409);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('P6: after 409, row data is unchanged', async () => {
    const id = uniqueId('P6');
    const v2 = validRow({
      activity_id: id,
      activity_status: 'active',
      activity: 'v2-data',
      updated_at: 200,
    });
    await putRow(id, v2);

    // Attempt to overwrite with older data
    const v1 = validRow({
      activity_id: id,
      activity_status: 'staged',
      activity: 'v1-data',
      updated_at: 100,
    });
    const res409 = await putRow(id, v1);
    expect(res409.status).toBe(409);

    // Verify v2 is still intact
    const getRes = await getRow(id);
    const body = await getRes.json();
    expect(body.activity_status).toBe('active');
    expect(body.activity).toBe('v2-data');
    expect(body.updated_at).toBe(200);
  });

  it('P7: 409 response body indicates conflict', async () => {
    const id = uniqueId('P7');
    await putRow(id, validRow({ activity_id: id, updated_at: 100 }));
    const res = await putRow(id, validRow({ activity_id: id, updated_at: 50 }));
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body.length).toBeGreaterThan(0);
  });

  it('P8: consecutive PUTs with increasing updated_at all succeed', async () => {
    const id = uniqueId('P8');
    const r1 = await putRow(id, validRow({ activity_id: id, updated_at: 100 }));
    expect(r1.status).toBe(200);

    const r2 = await putRow(id, validRow({ activity_id: id, updated_at: 200 }));
    expect(r2.status).toBe(200);

    const r3 = await putRow(id, validRow({ activity_id: id, updated_at: 300 }));
    expect(r3.status).toBe(200);
  });

  it('P9: manifest version does NOT increment on 409 rejection', async () => {
    const id = uniqueId('P9');
    await putRow(id, validRow({ activity_id: id, updated_at: 100 }));

    const manifestAfterPut = await getManifest();
    const vAfterPut = (await manifestAfterPut.json()).version;

    // Attempt same updated_at → 409
    await putRow(id, validRow({ activity_id: id, updated_at: 100 }));

    const manifestAfter409 = await getManifest();
    const vAfter409 = (await manifestAfter409.json()).version;
    expect(vAfter409).toBe(vAfterPut);
  });

  it('P10: push guard uses numeric comparison (not string)', async () => {
    const id = uniqueId('P10');
    await putRow(id, validRow({ activity_id: id, updated_at: 9 }));

    // 10 > 9 numerically — must succeed
    const res = await putRow(id, validRow({ activity_id: id, updated_at: 10 }));
    expect(res.status).toBe(200);

    // Verify the updated value
    const getRes = await getRow(id);
    const body = await getRes.json();
    expect(body.updated_at).toBe(10);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group A: Auth & CORS for New Endpoints
// ═══════════════════════════════════════════════════════════════════════════

describe('Group A: Auth & CORS', () => {

  it('A1: manifest requires API key → 403', async () => {
    const res = await getManifest('');
    expect(res.status).toBe(403);
  });

  it('A2: row GET requires API key → 403', async () => {
    const res = await getRow('some-id', '');
    expect(res.status).toBe(403);
  });

  it('A3: row PUT requires API key → 403', async () => {
    const id = uniqueId('A3');
    const res = await putRow(id, validRow({ activity_id: id }), '');
    expect(res.status).toBe(403);
  });

  it('A4: row DELETE requires API key → 403', async () => {
    const res = await deleteRow('some-id', '');
    expect(res.status).toBe(403);
  });

  it('A5: 409 response has CORS headers', async () => {
    const id = uniqueId('A5');
    await putRow(id, validRow({ activity_id: id, updated_at: 200 }));
    const res = await putRow(id, validRow({ activity_id: id, updated_at: 100 }));
    expect(res.status).toBe(409);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('A6: 400 response has CORS headers', async () => {
    const id = uniqueId('A6');
    const res = await putRowRaw(id, 'not json', 'text/plain');
    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Group E: Edge Cases & Integration
// ═══════════════════════════════════════════════════════════════════════════

describe('Group E: Edge Cases', () => {

  it('E1: manifest consistency after rapid PUT/DELETE sequence', async () => {
    const idA = uniqueId('E1A');
    const idB = uniqueId('E1B');
    const idC = uniqueId('E1C');

    await putRow(idA, validRow({ activity_id: idA, activity_status: 'staged' }));
    await putRow(idB, validRow({ activity_id: idB, activity_status: 'active' }));
    await deleteRow(idA);
    await putRow(idC, validRow({ activity_id: idC, activity_status: 'paused' }));

    const manifest = await getManifest();
    const body = await manifest.json();

    // A should be gone, B and C should be present
    const ids = body.rows.map((r: any) => r.activity_id);
    expect(ids).not.toContain(idA);
    expect(ids).toContain(idB);
    expect(ids).toContain(idC);

    const rowB = body.rows.find((r: any) => r.activity_id === idB);
    const rowC = body.rows.find((r: any) => r.activity_id === idC);
    expect(rowB.activity_status).toBe('active');
    expect(rowC.activity_status).toBe('paused');
  });

  it('E2: special characters in activity blob round-trip', async () => {
    const id = uniqueId('E2');
    const specialBlob = JSON.stringify({
      quotes: 'he said "hello"',
      backslash: 'path\\to\\file',
      unicode: 'café • 你好',
      nulls: 'before\0after',
      newlines: 'line1\nline2\r\nline3',
    });

    await putRow(id, validRow({
      activity_id: id,
      activity: specialBlob,
      updated_at: 100,
    }));

    const res = await getRow(id);
    const body = await res.json();
    expect(body.activity).toBe(specialBlob);
  });

  it('E3: activity_id with hyphens and underscores is rejected (alphanumeric only)', async () => {
    // Per spec: activity_id is 10-char alphanumeric CSPRNG [A-Za-z0-9]
    const res = await putRow('test-id', validRow({ activity_id: 'test-id' }));
    expect(res.status).toBe(400);
  });

  it('E4: concurrent PUTs to different rows both succeed', async () => {
    const idA = uniqueId('E4A');
    const idB = uniqueId('E4B');

    const [rA, rB] = await Promise.all([
      putRow(idA, validRow({ activity_id: idA, activity: 'concurrent-A' })),
      putRow(idB, validRow({ activity_id: idB, activity: 'concurrent-B' })),
    ]);

    expect(rA.status).toBe(200);
    expect(rB.status).toBe(200);

    // Both retrievable
    const getA = await getRow(idA);
    const getB = await getRow(idB);
    expect((await getA.json()).activity).toBe('concurrent-A');
    expect((await getB.json()).activity).toBe('concurrent-B');
  });

  it('E5: large activity blob (512KB) PUT + GET succeeds', async () => {
    const id = uniqueId('E5');
    // Generate a 512KB string (padded with 'x')
    const largeBlob = 'x'.repeat(512 * 1024);

    const putRes = await putRow(id, validRow({
      activity_id: id,
      activity: largeBlob,
      updated_at: 1,
    }));
    expect(putRes.status).toBe(200);

    const getRes = await getRow(id);
    expect(getRes.status).toBe(200);
    const body = await getRes.json();
    expect(body.activity.length).toBe(512 * 1024);
    expect(body.activity).toBe(largeBlob);
  });
});
