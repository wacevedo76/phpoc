/**
 * phpoc-staging Worker — stateless HTTP pass-through to R2 bucket.
 *
 * This Worker is a GENERIC HTTP-to-S3 proxy for opaque blobs, plus
 * row-level staging endpoints (ADR-025) for per-activity CRUD.
 *
 * It has NO knowledge of the phpoc encryption or blob format. Swap
 * R2 ↔ S3 ↔ Backblaze B2 by changing only the R2 binding.
 *
 * Endpoints:
 *   OPTIONS /{path}          → 204 (CORS preflight)
 *   GET /{path}              → 200 + body + ETag, or 404
 *   GET /{path} (If-None-Match) → 304 if ETag matches
 *   PUT /{path}              → 200 (store body), or 413
 *   DELETE /{path}           → 200 (remove blob)
 *   GET /?prefix={prefix}    → 200 + JSON array of keys
 *
 *   ── Row-Level Staging (ADR-025) → worker/src/row_level_staging.ts ──
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

import {
	ROWS_SUFFIX,
	MANIFEST_SUFFIX,
	handleGetManifest,
	handleGetRow,
	handlePutRow,
	handleDeleteRow,
} from './row_level_staging';

// ── CORS headers ────────────────────────────────────────────────────────────
// Applied to every response so browser-based clients (web app, Flutter
// WebView) can make cross-origin requests during development and in production.

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

// ── Environment ─────────────────────────────────────────────────────────────

export interface Env {
	PHPOC_BUCKET: R2Bucket;
	PHPOC_API_KEY?: string;
	API_KEY_ENV?: string;
}

// ── Router ──────────────────────────────────────────────────────────────────

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname === '/' ? '' : url.pathname.slice(1);

		// CORS preflight
		if (request.method === 'OPTIONS') {
			return withCors(new Response(null, { status: 204 }));
		}

		// Auth
		const apiKey = env.PHPOC_API_KEY;
		if (apiKey) {
			const provided = request.headers.get('X-Api-Key');
			if (!provided || provided !== apiKey) {
				return withCors(new Response('Unauthorized', { status: 403 }));
			}
		}

		// Route
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

// ── Generic Blob Handlers ───────────────────────────────────────────────────

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
	const ifNoneMatch = request.headers.get('If-None-Match');
	if (ifNoneMatch && ifNoneMatch === etag) {
		return new Response(null, { status: 304, headers: { ETag: etag } });
	}

	const body = await object.arrayBuffer();
	return new Response(body, {
		status: 200,
		headers: { 'Content-Type': 'application/octet-stream', 'ETag': etag },
	});
}

async function handlePut(
	request: Request,
	env: Env,
	path: string,
): Promise<Response> {
	if (!path) {
		return new Response('Bad Request: path required', { status: 400 });
	}

	const body = await request.arrayBuffer();
	if (body.byteLength > 100 * 1024 * 1024) {
		return new Response('Payload too large', { status: 413 });
	}

	await env.PHPOC_BUCKET.put(path, body);
	return new Response('OK', { status: 200 });
}

async function handleDelete(
	_request: Request,
	env: Env,
	path: string,
): Promise<Response> {
	if (!path) {
		return new Response('Bad Request: path required', { status: 400 });
	}

	await env.PHPOC_BUCKET.delete(path);
	return new Response('OK', { status: 200 });
}

async function handleList(
	_request: Request,
	env: Env,
	prefix: string,
): Promise<Response> {
	const listed = await env.PHPOC_BUCKET.list({ prefix });
	const files = listed.objects.map((obj) => obj.key).map((key) => key.slice(prefix.length));

	return new Response(JSON.stringify(files), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}
