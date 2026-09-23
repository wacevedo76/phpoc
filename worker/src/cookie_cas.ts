/**
 * worker/src/cookie_cas.ts — device-cookie stale-write CAS guard (ADR-034 §3a / I8).
 *
 * The ONLY Worker-side change in the ADR-034 plan: reject a device-cookie
 * PUT whose `seq` is present and `<=` the stored `seq` (409). Legacy cookies
 * without a `seq` are accepted last-write-wins (D9), so old clients are never
 * broken mid-migration. The Worker otherwise stays blind to blob format —
 * it reads exactly one known cookie field.
 */

/**
 * Pure write-arbitration rule (ADR-034 §3a):
 *
 *   incomingSeq absent  → false  (legacy client — last-write-wins, D9)
 *   storedSeq   absent  → false  (nothing to beat — accept)
 *   incomingSeq <= storedSeq → true   (409)
 *   incomingSeq >  storedSeq → false  (accept)
 *
 * @param incomingSeq - `seq` carried on the incoming PUT body (undefined if absent).
 * @param storedSeq    - `seq` read from the currently-stored cookie (undefined if absent).
 * @returns true when the incoming write is stale and must be rejected.
 */
export function isStaleWrite(incomingSeq?: number, storedSeq?: number): boolean {
	if (incomingSeq === undefined) return false; // legacy client — D9
	if (storedSeq === undefined) return false; // nothing to beat — accept
	return incomingSeq <= storedSeq;
}

/**
 * Extract a numeric `seq` from a device-cookie JSON body.
 *
 * Returns `undefined` when the body is malformed, the `seq` field is absent,
 * or the value is not a finite number — all of which are treated as "legacy /
 * no seq" (D9) by the caller, never as a stale-write signal.
 *
 * @param body - Raw JSON text of a device-cookie blob.
 * @returns The `seq` value, or `undefined` when not extractable.
 */
export function readCookieSeq(body: string): number | undefined {
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		if (typeof parsed.seq === 'number' && Number.isFinite(parsed.seq)) {
			return parsed.seq;
		}
	} catch {
		// malformed JSON → treated as no seq (legacy, D9)
	}
	return undefined;
}
