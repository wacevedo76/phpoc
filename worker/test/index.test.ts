/**
 * worker/test/index.test.ts — Cloudflare Worker HTTP endpoint integration tests.
 *
 * Tests the phpoc-staging Worker deployed at:
 *   https://phpoc-staging-testing.wacevedo.workers.dev
 *
 * Covers: auth, CORS, GET/PUT/DELETE round-trip, list files, error handling.
 *
 * These tests hit the LIVE test Worker — they require network access.
 * Use `npm test` or `npx vitest run` from the worker/ directory.
 *
 * The test Worker is a dedicated testing instance, separate from production.
 * All data written during tests is scoped to a test-specific prefix to avoid
 * interfering with other test runs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// ── Constants ────────────────────────────────────────────────────────────

const WORKER_URL = 'https://phpoc-staging-testing.wacevedo.workers.dev';
const API_KEY = 'ZfkbMrrdRaY7DeoanY1GqQAOSLDmI6gO';
const API_KEY_HEADER = 'X-Api-Key';

// Test prefix ensures no collision with real data or other test runs
const TEST_PREFIX = `_vitest_${Date.now()}_${Math.random().toString(36).slice(2, 8)}/`;

// ── Helpers ──────────────────────────────────────────────────────────────

function testPath(name: string): string {
  return `${TEST_PREFIX}${name}`;
}

async function put(path: string, body: Uint8Array | string, apiKey = API_KEY): Promise<Response> {
  const headers: Record<string, string> = {};
  if (apiKey) headers[API_KEY_HEADER] = apiKey;
  const data = typeof body === 'string' ? new TextEncoder().encode(body) : body;
  return fetch(`${WORKER_URL}/${path}`, { method: 'PUT', headers, body: data });
}

async function get(path: string, apiKey = API_KEY, etag?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (apiKey) headers[API_KEY_HEADER] = apiKey;
  if (etag) headers['If-None-Match'] = etag;
  return fetch(`${WORKER_URL}/${path}`, { method: 'GET', headers });
}

async function del(path: string, apiKey = API_KEY): Promise<Response> {
  const headers: Record<string, string> = {};
  if (apiKey) headers[API_KEY_HEADER] = apiKey;
  return fetch(`${WORKER_URL}/${path}`, { method: 'DELETE', headers });
}

async function listFiles(prefix: string, apiKey = API_KEY): Promise<Response> {
  const headers: Record<string, string> = {};
  if (apiKey) headers[API_KEY_HEADER] = apiKey;
  return fetch(`${WORKER_URL}/?prefix=${encodeURIComponent(prefix)}`, { method: 'GET', headers });
}

async function options(path: string): Promise<Response> {
  return fetch(`${WORKER_URL}/${path}`, { method: 'OPTIONS' });
}

// ── Cleanup ──────────────────────────────────────────────────────────────

// Delete all test objects after the suite runs
afterAll(async () => {
  // List and delete all objects under our test prefix
  const listed = await listFiles(TEST_PREFIX);
  if (listed.ok) {
    const files: string[] = await listed.json();
    await Promise.all(files.map(f => del(testPath(f)).catch(() => {})));
  }
});

// ── Suite ────────────────────────────────────────────────────────────────

describe('Worker HTTP Endpoints', () => {

  // ══════════════════════════════════════════════════════════════════
  // Group A: Authentication
  // ══════════════════════════════════════════════════════════════════

  describe('Group A: Authentication', () => {
    it('A1: rejects request without API key', async () => {
      const res = await get('staging/blobs/current.json', '');
      expect(res.status).toBe(403);
      expect(await res.text()).toBe('Unauthorized');
    });

    it('A2: rejects request with wrong API key', async () => {
      const res = await get('staging/blobs/current.json', 'wrong-key');
      expect(res.status).toBe(403);
    });

    it('A3: accepts request with correct API key', async () => {
      const res = await get('staging/blobs/current.json', API_KEY);
      // 404 is OK — means auth passed, just no data
      expect(res.status).not.toBe(403);
    });

    it('A4: rejects PUT without API key', async () => {
      const res = await put(testPath('auth-test.bin'), 'data', '');
      expect(res.status).toBe(403);
    });

    it('A5: rejects DELETE without API key', async () => {
      const res = await del(testPath('auth-test.bin'), '');
      expect(res.status).toBe(403);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Group B: CORS
  // ══════════════════════════════════════════════════════════════════

  describe('Group B: CORS', () => {
    it('B1: OPTIONS preflight returns 204', async () => {
      const res = await options('staging/blobs/current.json');
      expect(res.status).toBe(204);
    });

    it('B2: OPTIONS has Access-Control-Allow-Origin: *', async () => {
      const res = await options('staging/blobs/current.json');
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('B3: OPTIONS has correct Allow-Methods', async () => {
      const res = await options('staging/blobs/current.json');
      const methods = res.headers.get('Access-Control-Allow-Methods');
      expect(methods).toContain('GET');
      expect(methods).toContain('PUT');
      expect(methods).toContain('DELETE');
      expect(methods).toContain('OPTIONS');
    });

    it('B4: OPTIONS has correct Allow-Headers', async () => {
      const res = await options('staging/blobs/current.json');
      const headers = res.headers.get('Access-Control-Allow-Headers') || '';
      expect(headers).toContain('X-Api-Key');
      expect(headers).toContain('Content-Type');
      expect(headers).toContain('If-None-Match');
    });

    it('B5: OPTIONS has Max-Age', async () => {
      const res = await options('staging/blobs/current.json');
      expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
    });

    it('B6: GET response has CORS headers', async () => {
      const res = await get('staging/blobs/current.json');
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('B7: PUT response has CORS headers', async () => {
      const p = testPath('cors-put.bin');
      const res = await put(p, 'test');
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      await del(p); // cleanup
    });

    it('B8: 403 response has CORS headers', async () => {
      const res = await get('staging/blobs/current.json', '');
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('B9: 404 response has CORS headers', async () => {
      const res = await get(testPath('nonexistent.bin'));
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Group C: GET
  // ══════════════════════════════════════════════════════════════════

  describe('Group C: GET', () => {
    it('C1: GET existing blob returns 200', async () => {
      const p = testPath('get-test.bin');
      await put(p, 'hello world');
      const res = await get(p);
      expect(res.status).toBe(200);
      await del(p);
    });

    it('C2: GET returns correct body', async () => {
      const p = testPath('get-body.bin');
      const payload = 'exact match payload';
      await put(p, payload);
      const res = await get(p);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(payload);
      await del(p);
    });

    it('C3: GET returns Content-Type octet-stream', async () => {
      const p = testPath('get-ctype.bin');
      await put(p, 'data');
      const res = await get(p);
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
      await del(p);
    });

    it('C4: GET returns ETag header', async () => {
      const p = testPath('get-etag.bin');
      await put(p, 'data');
      const res = await get(p);
      expect(res.headers.get('ETag')).toBeTruthy();
      await del(p);
    });

    it('C5: GET nonexistent blob returns 404', async () => {
      const res = await get(testPath('does-not-exist-404.bin'));
      expect(res.status).toBe(404);
    });

    it('C6: GET with matching If-None-Match returns 304', async () => {
      const p = testPath('get-304.bin');
      await put(p, 'data for 304 test');
      const res1 = await get(p);
      const etag = res1.headers.get('ETag');
      expect(etag).toBeTruthy();

      const res2 = await get(p, API_KEY, etag!);
      expect(res2.status).toBe(304);
      expect(await res2.text()).toBe('');
      await del(p);
    });

    it('C7: GET with non-matching If-None-Match returns 200', async () => {
      const p = testPath('get-no-304.bin');
      await put(p, 'data');
      const res = await get(p, API_KEY, '"wrong-etag"');
      expect(res.status).toBe(200);
      await del(p);
    });

    it('C8: GET empty path returns 404', async () => {
      // Fetch root without a path
      const res = await fetch(`${WORKER_URL}/`, {
        method: 'GET',
        headers: { [API_KEY_HEADER]: API_KEY },
      });
      expect(res.status).toBe(404);
    });

    it('C9: GET binary data round-trips correctly', async () => {
      const p = testPath('get-binary.bin');
      const binary = new Uint8Array([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
      await put(p, binary);
      const res = await get(p);
      expect(res.status).toBe(200);
      const buf = await res.arrayBuffer();
      expect(new Uint8Array(buf)).toEqual(binary);
      await del(p);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Group D: PUT
  // ══════════════════════════════════════════════════════════════════

  describe('Group D: PUT', () => {
    it('D1: PUT returns 200 on success', async () => {
      const p = testPath('put-ok.bin');
      const res = await put(p, 'data');
      expect(res.status).toBe(200);
      await del(p);
    });

    it('D2: PUT empty path returns 400', async () => {
      const res = await fetch(`${WORKER_URL}/`, {
        method: 'PUT',
        headers: { [API_KEY_HEADER]: API_KEY },
        body: 'data',
      });
      expect(res.status).toBe(400);
    });

    it('D3: PUT + GET round-trip preserves data', async () => {
      const p = testPath('put-roundtrip.bin');
      const payload = JSON.stringify({ key: 'value', nested: { a: 1, b: [2, 3] } });
      await put(p, payload);
      const res = await get(p);
      expect(await res.text()).toBe(payload);
      await del(p);
    });

    it('D4: PUT overwrites existing blob', async () => {
      const p = testPath('put-overwrite.bin');
      await put(p, 'first write');
      await put(p, 'second write');
      const res = await get(p);
      expect(await res.text()).toBe('second write');
      await del(p);
    });

    it('D5: PUT large payload (64KB) succeeds', async () => {
      const p = testPath('put-large.bin');
      const data = new Uint8Array(64 * 1024);
      // Fill with non-zero data
      for (let i = 0; i < data.length; i++) data[i] = (i % 256);
      const res = await put(p, data);
      expect(res.status).toBe(200);
      await del(p);
    });

    it('D6: PUT empty body succeeds', async () => {
      const p = testPath('put-empty.bin');
      const res = await put(p, new Uint8Array(0));
      expect(res.status).toBe(200);
      const getRes = await get(p);
      expect(await getRes.text()).toBe('');
      await del(p);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Group E: DELETE
  // ══════════════════════════════════════════════════════════════════

  describe('Group E: DELETE', () => {
    it('E1: DELETE existing blob returns 200', async () => {
      const p = testPath('del-ok.bin');
      await put(p, 'data');
      const res = await del(p);
      expect(res.status).toBe(200);
    });

    it('E2: DELETE nonexistent blob returns 200 (idempotent)', async () => {
      const res = await del(testPath('del-nonexistent.bin'));
      // Worker returns 200 for deleting nonexistent keys (idempotent)
      expect(res.status).toBe(200);
    });

    it('E3: DELETE removes blob (subsequent GET returns 404)', async () => {
      const p = testPath('del-verify.bin');
      await put(p, 'data');
      await del(p);
      const res = await get(p);
      expect(res.status).toBe(404);
    });

    it('E4: DELETE empty path returns 400', async () => {
      const res = await fetch(`${WORKER_URL}/`, {
        method: 'DELETE',
        headers: { [API_KEY_HEADER]: API_KEY },
      });
      expect(res.status).toBe(400);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Group F: List files
  // ══════════════════════════════════════════════════════════════════

  describe('Group F: List files', () => {
    it('F1: list with prefix returns JSON array', async () => {
      const pfx = testPath('list-test');
      await put(`${pfx}/a.bin`, 'a');
      await put(`${pfx}/b.bin`, 'b');

      const res = await listFiles(pfx);
      expect(res.status).toBe(200);
      const files: string[] = await res.json();
      expect(Array.isArray(files)).toBe(true);
      expect(files).toContain('/a.bin');
      expect(files).toContain('/b.bin');

      await del(`${pfx}/a.bin`);
      await del(`${pfx}/b.bin`);
    });

    it('F2: list empty prefix returns empty array', async () => {
      const res = await listFiles(testPath('empty-prefix'));
      expect(res.status).toBe(200);
      const files: string[] = await res.json();
      expect(files).toEqual([]);
    });

    it('F3: list returns Content-Type application/json', async () => {
      const res = await listFiles(testPath('ctype'));
      expect(res.headers.get('Content-Type')).toBe('application/json');
    });

    it('F4: list with prefix returns only matching keys', async () => {
      const prefixA = testPath('list-filter-a');
      const prefixB = testPath('list-filter-b');
      await put(`${prefixA}/x.bin`, 'x');
      await put(`${prefixB}/y.bin`, 'y');

      const res = await listFiles(prefixA);
      const files: string[] = await res.json();
      // Should only contain files under prefixA
      expect(files.some((f: string) => f.includes('y.bin'))).toBe(false);

      await del(`${prefixA}/x.bin`);
      await del(`${prefixB}/y.bin`);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Group G: Staging-specific paths
  // ══════════════════════════════════════════════════════════════════

  describe('Group G: Staging blob paths', () => {
    it('G1: staging/blobs/current.json path works', async () => {
      // These paths may or may not exist — we just verify they return
      // 200 or 404, not 403 or 500
      const res = await get('staging/blobs/current.json');
      expect([200, 404]).toContain(res.status);
    });

    it('G2: staging/blobs/device_cookie.bin path works', async () => {
      const res = await get('staging/blobs/device_cookie.bin');
      expect([200, 404]).toContain(res.status);
    });

    it('G3: ledger/blocks/000000.json path works', async () => {
      const res = await get('ledger/blocks/000000.json');
      expect([200, 404]).toContain(res.status);
    });

    it('G4: ledger/hash_index.sha256 path works', async () => {
      const res = await get('ledger/hash_index.sha256');
      expect([200, 404]).toContain(res.status);
    });

    it('G5: ledger/index.json path works', async () => {
      const res = await get('ledger/index.json');
      expect([200, 404]).toContain(res.status);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Group H: Method validation
  // ══════════════════════════════════════════════════════════════════

  describe('Group H: Method validation', () => {
    it('H1: POST returns 405 Method Not Allowed', async () => {
      const res = await fetch(`${WORKER_URL}/staging/blobs/current.json`, {
        method: 'POST',
        headers: { [API_KEY_HEADER]: API_KEY },
        body: 'data',
      });
      expect(res.status).toBe(405);
    });

    it('H2: PATCH returns 405 Method Not Allowed', async () => {
      const res = await fetch(`${WORKER_URL}/staging/blobs/current.json`, {
        method: 'PATCH',
        headers: { [API_KEY_HEADER]: API_KEY },
        body: 'data',
      });
      expect(res.status).toBe(405);
    });

    it('H3: HEAD returns 405 Method Not Allowed (falls through to default)', async () => {
      const res = await fetch(`${WORKER_URL}/staging/blobs/current.json`, {
        method: 'HEAD',
        headers: { [API_KEY_HEADER]: API_KEY },
      });
      expect(res.status).toBe(405);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Group I: Error edge cases
  // ══════════════════════════════════════════════════════════════════

  describe('Group I: Error edge cases', () => {
    it('I1: GET with special characters in path', async () => {
      const p = testPath('special chars !@#$.bin');
      await put(p, 'data');
      const res = await get(p);
      expect(res.status).toBe(200);
      await del(p);
    });

    it('I2: GET with URL-encoded path', async () => {
      const p = testPath('encoded%20path.bin');
      await put(p, 'data');
      const res = await get(p);
      expect(res.status).toBe(200);
      await del(p);
    });

    it('I3: multiple concurrent GETs to same blob', async () => {
      const p = testPath('concurrent.bin');
      await put(p, 'concurrent data');
      const results = await Promise.all([get(p), get(p), get(p)]);
      results.forEach(r => expect(r.status).toBe(200));
      const bodies = await Promise.all(results.map(r => r.text()));
      bodies.forEach(b => expect(b).toBe('concurrent data'));
      await del(p);
    });

    it('I4: PUT then immediate GET (no race)', async () => {
      const p = testPath('write-read.bin');
      await put(p, 'immediate');
      const res = await get(p);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('immediate');
      await del(p);
    });
  });
});
