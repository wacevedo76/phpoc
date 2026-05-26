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
 *   GET /{path}               → 200 + body + ETag, or 404
 *   GET /{path} (If-None-Match) → 304 if ETag matches
 *   PUT /{path}               → 200 (store body), or 413
 *   GET /?prefix={prefix}     → 200 + JSON array of keys
 *
 * Auth: X-Api-Key header must match PHPOC_API_KEY secret.
 * Method: Only GET and PUT are allowed; others return 405.
 */

export interface Env {
	PHPOC_BUCKET: R2Bucket;
	PHPOC_API_KEY?: string;
	API_KEY_ENV?: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// ── Auth ─────────────────────────────────────────────────────
		const apiKey = env.PHPOC_API_KEY;
		if (apiKey) {
			const provided = request.headers.get('X-Api-Key');
			if (!provided || provided !== apiKey) {
				return new Response('Unauthorized', { status: 403 });
			}
		}

		const url = new URL(request.url);
		const path = url.pathname === '/' ? '' : url.pathname.slice(1);

		// ── Route ────────────────────────────────────────────────────
		switch (request.method) {
			case 'GET':
				if (url.searchParams.has('prefix')) {
					return handleList(request, env, url.searchParams.get('prefix')!);
				}
				return handleGet(request, env, path);

			case 'PUT':
				return handlePut(request, env, path);

			default:
				return new Response('Method Not Allowed', { status: 405 });
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
