/**
 * phpoc-staging Worker — stateless HTTP pass-through to R2 bucket.
 *
 * This Worker is a GENERIC HTTP-to-S3 proxy. It has NO knowledge of the
 * phpoc data model, encryption, or blob format. It stores and retrieves
 * opaque bytes by key, with ETag-based freshness.
 *
 * Swap R2 ↔ S3 ↔ Backblaze B2 by changing only the R2 binding name
 * and this module's storage calls — the Python HttpStagingTransport
 * never changes.
 *
 * Endpoints:
 *   OPTIONS /{path}          → 204 (CORS preflight)
 *   GET /{path}              → 200 + body + ETag, or 404
 *   GET /{path} (If-None-Match) → 304 if ETag matches
 *   PUT /{path}              → 200 (store body), or 413
 *   DELETE /{path}           → 200 (remove blob)
 *   GET /?prefix={prefix}    → 200 + JSON array of keys
 *
 *   ── Row-Level Staging (ADR-025) ──
 *   GET  /.../storage/staging/manifest          → 200 + {rows: [...], version: N}
 *   GET  /.../storage/staging/rows/{id}         → 200 + row JSON, or 404
 *   PUT  /.../storage/staging/rows/{id}         → 200 | 400 | 409
 *   DELETE /.../storage/staging/rows/{id}       → 200 | 404
 *
 * Auth:
 *   - X-Api-Key header (shared secret) — required if PHPOC_API_KEY is set
 *   - CORS headers on all responses — enables browser-based clients
 *
 * Methods: OPTIONS, GET, PUT, and DELETE are allowed; others return 405.
 */

// ── CORS headers ────────────────────────────────────────────────────────────
// Applied to every response so browser-based clients (web app, Flutter
// WebView) can make cross-origin requests during development and in production.
//
// - Allow-Origin: * — any dev server (localhost:3000, etc.)
// - Allow-Methods: GET, PUT, DELETE, OPTIONS — matches the Worker's route table
// - Allow-Headers: headers the Worker actually reads
// - Max-Age: 86400 — cache preflight for 24h to reduce latency

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'X-Api-Key, Content-Type, If-None-Match',
	'Access-Control-Max-Age': '86400',
};

/** Wrap a Response with CORS headers. */
function withCors(response: Response): Response {
	for (const [key, value] of Object.entries(CORS_HEADERS)) {
		response.headers.set(key, value);
	}
	return response;
}

// ── Row-Level Staging Types ────────────────────────────────────────────────

interface StagingRow {
	activity_id: string;
	activity_status: string;
	activity: string;
	updated_at: number;
	[key: string]: unknown; // forward-compat: preserve extra fields
}

interface ManifestRow {
	activity_id: string;
	activity_status: string;
	updated_at: number;
}

interface Manifest {
	rows: ManifestRow[];
	version: number;
}

const VALID_STATUSES = new Set(['staged', 'active', 'paused']);
const ACTIVITY_ID_RE = /^[A-Za-z0-9]{1,20}$/;
const ROWS_SUFFIX = 'storage/staging/rows/';
const MANIFEST_SUFFIX = 'storage/staging/manifest';

// ── Path Parsing ──────────────────────────────────────────────────────────

interface StagingPath {
	type: 'manifest' | 'row';
	base: string; // everything before storage/staging/
	activityId?: string;
}

function parseStagingPath(path: string): StagingPath | null {
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

function validateRowBody(body: Record<string, unknown>): string | null {
	if (typeof body.activity_id !== 'string') return 'Missing or invalid activity_id';
	if (typeof body.activity_status !== 'string') return 'Missing or invalid activity_status';
	if (typeof body.activity !== 'string') return 'Missing or invalid activity';
	if (body.updated_at === undefined || body.updated_at === null) return 'Missing updated_at';
	if (typeof body.updated_at !== 'number' || !Number.isInteger(body.updated_at)) return 'updated_at must be an integer';
	if (body.updated_at < 0) return 'updated_at must be non-negative';
	if (body.activity.length === 0) return 'activity must not be empty';
	if (!ACTIVITY_ID_RE.test(body.activity_id)) return 'activity_id must be 1-20 alphanumeric characters';
	if (body.activity_id.includes('/') || body.activity_id.includes('..')) return 'activity_id must not contain path separators';
	if (!VALID_STATUSES.has(body.activity_status)) return 'activity_status must be one of: staged, active, paused';
	return null;
}

// ── Manifest Helpers ──────────────────────────────────────────────────────

function manifestKey(base: string): string {
	return `${base}${MANIFEST_SUFFIX}`;
}

function rowKey(base: string, activityId: string): string {
	return `${base}${ROWS_SUFFIX}${activityId}`;
}

async function readManifest(env: Env, base: string): Promise<Manifest> {
	const object = await env.PHPOC_BUCKET.get(manifestKey(base));
	if (object === null) return { rows: [], version: 0 };
	const text = await object.text();
	return JSON.parse(text) as Manifest;
}

async function writeManifest(env: Env, base: string, manifest: Manifest): Promise<void> {
	await env.PHPOC_BUCKET.put(manifestKey(base), JSON.stringify(manifest));
}

function addRowToManifest(manifest: Manifest, row: StagingRow): Manifest {
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

function removeRowFromManifest(manifest: Manifest, activityId: string): Manifest {
	manifest.rows = manifest.rows.filter((r) => r.activity_id !== activityId);
	manifest.version = (manifest.version ?? 0) + 1;
	return manifest;
}

// ── Row-Level Staging Handlers ────────────────────────────────────────────

async function handleGetManifest(env: Env, path: string): Promise<Response> {
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

async function handleGetRow(env: Env, path: string): Promise<Response> {
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

async function handlePutRow(request: Request, env: Env, path: string): Promise<Response> {
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

	if (body.activity_id !== info.activityId) {
		return new Response(JSON.stringify({ error: 'activity_id in body must match URL path' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const existing = await env.PHPOC_BUCKET.get(rowKey(info.base, info.activityId));
	if (existing !== null) {
		const existingBody = await existing.json() as StagingRow;
		if ((body.updated_at as number) <= existingBody.updated_at) {
			return new Response(JSON.stringify({ error: 'Conflict: updated_at is not newer than existing row' }), {
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	await env.PHPOC_BUCKET.put(rowKey(info.base, info.activityId), JSON.stringify(body));

	const manifest = await readManifest(env, info.base);
	await writeManifest(env, info.base, addRowToManifest(manifest, body as unknown as StagingRow));

	return new Response('OK', { status: 200 });
}

async function handleDeleteRow(env: Env, path: string): Promise<Response> {
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

export interface Env {
	PHPOC_BUCKET: R2Bucket;
	PHPOC_API_KEY?: string;
	API_KEY_ENV?: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname === '/' ? '' : url.pathname.slice(1);

		// ── CORS preflight ───────────────────────────────────────────
		if (request.method === 'OPTIONS') {
			return withCors(new Response(null, { status: 204 }));
		}

		// ── Auth ─────────────────────────────────────────────────────
		const apiKey = env.PHPOC_API_KEY;
		if (apiKey) {
			const provided = request.headers.get('X-Api-Key');
			if (!provided || provided !== apiKey) {
				return withCors(new Response('Unauthorized', { status: 403 }));
			}
		}

		// ── Route ────────────────────────────────────────────────────
		switch (request.method) {
			case 'GET':
				if (url.searchParams.has('prefix')) {
					return withCors(await handleList(request, env, url.searchParams.get('prefix')!));
				}
				if (path.endsWith(MANIFEST_SUFFIX)) {
					return withCors(await handleGetManifest(env, path));
				}
				if (path.includes(ROWS_SUFFIX)) {
					return withCors(await handleGetRow(env, path));
				}
				return withCors(await handleGet(request, env, path));

			case 'PUT':
				if (path.includes(ROWS_SUFFIX)) {
					return withCors(await handlePutRow(request, env, path));
				}
				return withCors(await handlePut(request, env, path));

			case 'DELETE':
				if (path.includes(ROWS_SUFFIX)) {
					return withCors(await handleDeleteRow(env, path));
				}
				return withCors(await handleDelete(request, env, path));

			default:
				return withCors(new Response('Method Not Allowed', { status: 405 }));
		}
	},
};

/**
 * GET /{path} — Retrieve a blob from R2.
 *
 * Returns 304 Not Modified if the client sends a matching If-None-Match.
 * Returns 404 if the key does not exist.
 */
async function handleGet(
	request: Request,
	env: Env,
	path: string,
): Promise<Response> {
	if (!path) {
		return new Response('Not Found', { status: 404 });
	}

	const object = await env.PHPOC_BUCKET.get(path);
	if (object === null) {
		return new Response('Not Found', { status: 404 });
	}

	const etag = object.httpEtag;

	// Check If-None-Match for 304 fast-path
	const ifNoneMatch = request.headers.get('If-None-Match');
	if (ifNoneMatch && ifNoneMatch === etag) {
		return new Response(null, {
			status: 304,
			headers: { ETag: etag },
		});
	}

	const body = await object.arrayBuffer();
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': 'application/octet-stream',
			'ETag': etag,
		},
	});
}

/**
 * DELETE /{path} — Remove a blob from R2.
 *
 * Returns 200 on success. Returns 404 if the key does not exist
 * (idempotent — deleting a non-existent key is harmless).
 */
async function handleDelete(
	request: Request,
	env: Env,
	path: string,
): Promise<Response> {
	if (!path) {
		return new Response('Bad Request: path required', { status: 400 });
	}

	await env.PHPOC_BUCKET.delete(path);
	return new Response('OK', { status: 200 });
}

/**
 * PUT /{path} — Store a blob in R2.
 *
 * Returns 200 on success. Returns 413 if body exceeds 100MB.
 */
async function handlePut(
	request: Request,
	env: Env,
	path: string,
): Promise<Response> {
	if (!path) {
		return new Response('Bad Request: path required', { status: 400 });
	}

	const body = await request.arrayBuffer();
	const size = body.byteLength;

	// Reject payloads over 100MB
	if (size > 100 * 1024 * 1024) {
		return new Response('Payload too large', { status: 413 });
	}

	await env.PHPOC_BUCKET.put(path, body);
	return new Response('OK', { status: 200 });
}

/**
 * GET /?prefix={prefix} — List keys under a prefix.
 *
 * Returns a JSON array of key names (basenames only, including prefix).
 * Returns an empty array if no keys match.
 */
async function handleList(
	_request: Request,
	env: Env,
	prefix: string,
): Promise<Response> {
	const listed = await env.PHPOC_BUCKET.list({ prefix });

	// Extract just the key names (full paths)
	const keys = listed.objects.map((obj) => obj.key);

	// Strip prefix to return filenames only
	const files = keys.map((key) => key.slice(prefix.length));

	return new Response(JSON.stringify(files), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}
