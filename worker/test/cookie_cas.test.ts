/**
 * worker/test/cookie_cas.test.ts — Worker cookie CAS pure rule (Phase 2: RED).
 *
 * Hermetic unit tests for the `isStaleWrite` pure function (ADR-034 §3a / I8).
 * No network, no R2 binding — just the write-arbitration rule:
 *
 *   isStaleWrite(incomingSeq, storedSeq):
 *     incomingSeq absent  → false  (legacy client — last-write-wins, D9)
 *     storedSeq   absent  → false  (nothing to beat — accept)
 *     incomingSeq <= storedSeq → true   (409)
 *     incomingSeq >  storedSeq → false  (accept)
 *
 * Phase 2 (RED): `src/cookie_cas.ts` does not exist yet, so `isStaleWrite`
 * resolves to `undefined` and every test fails on the `toBeTypeOf('function')`
 * assertion (not an import error — the dynamic import is guarded).
 *
 * Blueprint: docs/planning/STAGING_COOKIE_CAS_PHASE1.md (Group J: J1–J5)
 *
 * Run: cd worker && npx vitest run test/cookie_cas.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';

type IsStaleWrite = (incomingSeq?: number, storedSeq?: number) => boolean;
type ReadCookieSeq = (body: string) => number | undefined;

let isStaleWrite: IsStaleWrite | undefined;
let readCookieSeq: ReadCookieSeq | undefined;

beforeAll(async () => {
  try {
    const mod = await import('../src/cookie_cas');
    isStaleWrite = (mod as { isStaleWrite?: IsStaleWrite }).isStaleWrite;
    readCookieSeq = (mod as { readCookieSeq?: ReadCookieSeq }).readCookieSeq;
  } catch {
    // Module not created yet (RED phase) — helpers stay undefined.
    isStaleWrite = undefined;
    readCookieSeq = undefined;
  }
});

describe('isStaleWrite — pure CAS rule (J1–J5)', () => {
  it('J1: legacy incoming (undefined seq) is never stale', () => {
    expect(isStaleWrite).toBeTypeOf('function');
    expect(isStaleWrite!(undefined, 5)).toBe(false);
  });

  it('J2: no stored seq to beat → never stale', () => {
    expect(isStaleWrite).toBeTypeOf('function');
    expect(isStaleWrite!(5, undefined)).toBe(false);
  });

  it('J3: incoming < stored → stale (true)', () => {
    expect(isStaleWrite).toBeTypeOf('function');
    expect(isStaleWrite!(4, 5)).toBe(true);
  });

  it('J4: incoming == stored → stale (true)', () => {
    expect(isStaleWrite).toBeTypeOf('function');
    expect(isStaleWrite!(5, 5)).toBe(true);
  });

  it('J5: incoming > stored → accept (false)', () => {
    expect(isStaleWrite).toBeTypeOf('function');
    expect(isStaleWrite!(6, 5)).toBe(false);
  });
});

describe('readCookieSeq — cookie seq extraction (J helper)', () => {
  it('extracts a finite numeric seq', () => {
    expect(readCookieSeq).toBeTypeOf('function');
    expect(readCookieSeq!('{"seq":5}')).toBe(5);
    expect(readCookieSeq!('{"device_uuid":"a","seq":0}')).toBe(0);
  });

  it('returns undefined for malformed JSON', () => {
    expect(readCookieSeq!('not json')).toBeUndefined();
  });

  it('returns undefined when seq is absent', () => {
    expect(readCookieSeq!('{"device_uuid":"a"}')).toBeUndefined();
  });

  it('returns undefined when seq is not a finite number', () => {
    expect(readCookieSeq!('{"seq":"5"}')).toBeUndefined();
    expect(readCookieSeq!('{"seq":null}')).toBeUndefined();
  });
});
