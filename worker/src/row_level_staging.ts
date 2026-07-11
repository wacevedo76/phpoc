/**
 * worker/src/row_level_staging.ts — Row-Level Staging handlers (ADR-025).
 *
 * Extracted from index.ts during Phase 4 REFACTOR for modularity.
 * Exports four HTTP handlers + shared types and validation.
 */

// ── Types ─────────────────────────────────────────────────────────────────

export interface StagingRow {
	activity_id: string;
	activity_status: string;
	activity: string;
	updated_at: number;
	[key: string]: unknown; // forward-compat: preserve extra fields
}

export interface ManifestRow {
	activity_id: string;
	activity_status: string;
	updated_at: number;
}

export interface Manifest {
	rows: ManifestRow[];
	version: number;
}

// ── Constants ─────────────────────────────────────────────────────────────

/** Valid activity_status values per ADR-025 row schema. */
export const VALID_STATUSES = new Set(['staged', 'active', 'paused']);

/**
 * Activity IDs are 10-char CSPRNG alphanumeric strings.
 * We allow 10–20 chars as a validation gate (upper bound for safety).
 * Spec: generateActivityId() produces exactly 10 chars.
 */
export const ACTIVITY_ID_RE = /^[A-Za-z0-9]{10,20}$/;

export const ROWS_SUFFIX = 'storage/staging/rows/';
export const MANIFEST_SUFFIX = 'storage/staging/manifest';

// ── Path Parsing ──────────────────────────────────────────────────────────

export interface StagingPath {
	type: 'manifest' | 'row';
	base: string; // everything before storage/staging/
	activityId?: string;
}

export function parseStagingPath(path: string): StagingPath | null {
	// Manifest: ends with "storage/staging/manifest"
	if (path.endsWith(MANIFEST_SUFFIX)) {
		const base = path.slice(0, -MANIFEST_SUFFIX.length);
		return { type: 'manifest', base };
	}

	// Row: contains "storage/staging/rows/"
	const idx = path.indexOf(ROWS_SUFFIX);
	if (idx !== -1) {
		const base = path.slice(0, idx);
		const activityId = path.slice(idx + ROWS_SUFFIX.length);
		return { type: 'row', base, activityId };
	}

	return null;
}

// ── Validation ────────────────────────────────────────────────────────────

/**
 * Validate a row body for PUT requests. Returns an error message string if
 * invalid, or null if the body passes all checks and can be treated as a
 * valid StagingRow.
 */
export function validateRowBody(body: Record<string, unknown>): string | null {
	if (typeof body.activity_id !== 'string') return 'Missing or invalid activity_id';
	if (typeof body.activity_status !== 'string') return 'Missing or invalid activity_status';
	if (typeof body.activity !== 'string') return 'Missing or invalid activity';
	if (body.updated_at === undefined || body.updated_at === null) return 'Missing updated_at';
	if (typeof body.updated_at !== 'number' || !Number.isInteger(body.updated_at)) return 'updated_at must be an integer';
	if (body.updated_at < 0) return 'updated_at must be non-negative';
	if (body.activity.length === 0) return 'activity must not be empty';
	if (!ACTIVITY_ID_RE.test(body.activity_id)) return 'activity_id must be 10-20 alphanumeric characters';
	if (body.activity_id.includes('/') || body.activity_id.includes('..')) return 'activity_id must not contain path separators';
	if (!VALID_STATUSES.has(body.activity_status)) return 'activity_status must be one of: staged, active, paused';
	return null;
}

// ── Manifest Helpers ──────────────────────────────────────────────────────

export function manifestKey(base: string): string {
	return `${base}${MANIFEST_SUFFIX}`;
}

export function rowKey(base: string, activityId: string): string {
	return `${base}${ROWS_SUFFIX}${activityId}`;
}

export async function readManifest(env: RowLevelEnv, base: string): Promise<Manifest> {
	const object = await env.PHPOC_BUCKET.get(manifestKey(base));
	if (object === null) return { rows: [], version: 0 };
	const text = await object.text();
	return JSON.parse(text) as Manifest;
}

export async function writeManifest(env: RowLevelEnv, base: string, manifest: Manifest): Promise<void> {
	await env.PHPOC_BUCKET.put(manifestKey(base), JSON.stringify(manifest));
}

export function addRowToManifest(manifest: Manifest, row: StagingRow): Manifest {
	const manifestRow: ManifestRow = {
		activity_id: row.activity_id,
		activity_status: row.activity_status,
		updated_at: row.updated_at,
	};
	const idx = manifest.rows.findIndex((r) => r.activity_id === row.activity_id);
	if (idx >= 0) {
		manifest.rows[idx] = manifestRow;
	} else {
		manifest.rows.push(manifestRow);
	}
	manifest.version = (manifest.version ?? 0) + 1;
	return manifest;
}

export function removeRowFromManifest(manifest: Manifest, activityId: string): Manifest {
	manifest.rows = manifest.rows.filter((r) => r.activity_id !== activityId);
	manifest.version = (manifest.version ?? 0) + 1;
	return manifest;
}

// ── HTTP Handlers ─────────────────────────────────────────────────────────

/** Shared dependency: R2 bucket binding. Avoids importing full Env. */
export interface RowLevelEnv {
	PHPOC_BUCKET: R2Bucket;
}

export async function handleGetManifest(env: RowLevelEnv, path: string): Promise<Response> {
	const info = parseStagingPath(path);
	if (!info || info.type !== 'manifest') {
		return new Response('Not Found', { status: 404 });
	}
	const manifest = await readManifest(env, info.base);
	return new Response(JSON.stringify(manifest), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

export async function handleGetRow(env: RowLevelEnv, path: string): Promise<Response> {
	const info = parseStagingPath(path);
	if (!info || info.type !== 'row' || !info.activityId) {
		return new Response('Not Found', { status: 404 });
	}
	const object = await env.PHPOC_BUCKET.get(rowKey(info.base, info.activityId));
	if (object === null) {
		return new Response('Not Found', { status: 404 });
	}
	const body = await object.text();
	return new Response(body, {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

export async function handlePutRow(request: Request, env: RowLevelEnv, path: string): Promise<Response> {
	const info = parseStagingPath(path);
	if (!info || info.type !== 'row' || !info.activityId) {
		return new Response('Not Found', { status: 404 });
	}

	const contentType = request.headers.get('Content-Type') || '';
	if (!contentType.includes('application/json')) {
		return new Response(JSON.stringify({ error: 'Content-Type must be application/json' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	let body: Record<string, unknown>;
	try {
		body = await request.json() as Record<string, unknown>;
	} catch {
		return new Response(JSON.stringify({ error: 'Body must be valid JSON' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const err = validateRowBody(body);
	if (err) {
		return new Response(JSON.stringify({ error: err }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	// After validation, body conforms to StagingRow
	const row = body as unknown as StagingRow;

	if (row.activity_id !== info.activityId) {
		return new Response(JSON.stringify({ error: 'activity_id in body must match URL path' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const existing = await env.PHPOC_BUCKET.get(rowKey(info.base, info.activityId));
	if (existing !== null) {
		const existingRow = await existing.json() as StagingRow;
		if (row.updated_at <= existingRow.updated_at) {
			return new Response(JSON.stringify({ error: 'Conflict: updated_at is not newer than existing row' }), {
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	await env.PHPOC_BUCKET.put(rowKey(info.base, info.activityId), JSON.stringify(body));

	const manifest = await readManifest(env, info.base);
	await writeManifest(env, info.base, addRowToManifest(manifest, row));

	return new Response('OK', { status: 200 });
}

export async function handleDeleteRow(env: RowLevelEnv, path: string): Promise<Response> {
	const info = parseStagingPath(path);
	if (!info || info.type !== 'row' || !info.activityId) {
		return new Response('Not Found', { status: 404 });
	}

	const existing = await env.PHPOC_BUCKET.get(rowKey(info.base, info.activityId));
	if (existing === null) {
		return new Response('Not Found', { status: 404 });
	}

	await env.PHPOC_BUCKET.delete(rowKey(info.base, info.activityId));

	const manifest = await readManifest(env, info.base);
	await writeManifest(env, info.base, removeRowFromManifest(manifest, info.activityId));

	return new Response('OK', { status: 200 });
}
