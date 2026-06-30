/* tslint:disable */
/* eslint-disable */

/**
 * Full authentication flow: passphrase → PDK → master key (for JS convenience).
 *
 * In the CLI this is a multi-step process (PDK decrypts seed, seed decodes
 * to master key). In the web app, the seed is typically already available
 * from secure storage, so this flow is only needed during first-time setup.
 *
 * * `passphrase` — user's passphrase.
 * * `seed` — base64-encoded recovery seed.
 * * `iterations` — PBKDF2 iterations (600000 or 100000).
 *
 * Returns the hex-encoded master key on success.
 */
export function authenticate(_passphrase: string, seed: string, _iterations: number): string;

/**
 * Decrypt a hex-encoded ciphertext with the given master key.
 *
 * * `ciphertext_hex` — hex-encoded ciphertext from `encrypt()`.
 * * `master_key_hex` — 64-char hex-encoded 32-byte master key.
 *
 * Returns the original plaintext, or throws on auth tag mismatch / wrong key.
 */
export function decrypt(ciphertext_hex: string, master_key_hex: string): string;

/**
 * Deobfuscate a staging blob after pulling from remote.
 *
 * * `obfuscated_b64` — base64-encoded obfuscated bytes.
 * * `master_key_hex` — 64-char hex-encoded 32-byte master key.
 *
 * Returns original plaintext JSON string, or throws an error.
 */
export function deobfuscate_blob(obfuscated_b64: string, master_key_hex: string): string;

/**
 * Derive the blob obfuscation sub-key (hex-encoded, 16 bytes → 32 hex chars).
 */
export function derive_blob_key(master_key_hex: string): string;

/**
 * Derive the 32-byte Master Key from a base64-encoded recovery seed.
 *
 * Returns hex-encoded 64-character master key, or throws an error.
 */
export function derive_master_key(seed: string): string;

/**
 * Derive a Passphrase-Derived Key (PDK) via PBKDF2-HMAC-SHA256.
 *
 * * `passphrase` — user's passphrase.
 * * `iterations` — 600000 (standard) or 100000 (legacy / pre-R3 genesis).
 *
 * Returns hex-encoded 32-byte PDK.
 */
export function derive_pdk(passphrase: string, iterations: number): string;

/**
 * Derive the sealing sub-key (hex-encoded, 32 bytes → 64 hex chars).
 */
export function derive_seal_key(master_key_hex: string): string;

/**
 * Compute a device proof: HMAC-SHA256(MK, "phpoc:device:" + device_id).
 *
 * Returns 64-char hex string.
 */
export function device_proof(master_key_hex: string, device_id: string): string;

/**
 * Encrypt plaintext with the given master key.
 *
 * * `plaintext` — UTF-8 text to encrypt.
 * * `master_key_hex` — 64-char hex-encoded 32-byte master key.
 *
 * Returns hex-encoded ciphertext (salt + nonce + ciphertext + auth tag).
 */
export function encrypt(plaintext: string, master_key_hex: string): string;

/**
 * Generate a random device specifier (32-char hex).
 */
export function generate_device_specifier(): string;

/**
 * Generate a 32-byte (256-bit) recovery seed, base64-encoded.
 */
export function generate_seed(): string;

/**
 * Generate a random UUID v4 string.
 */
export function generate_uuid_v4(): string;

/**
 * Derive a deterministic device ID from the master key.
 *
 * Returns 64-char hex string (HMAC-SHA256(MK, "device:id")).
 */
export function get_device_id(master_key_hex: string): string;

/**
 * Obfuscate a staging blob for remote transport.
 *
 * * `plaintext` — UTF-8 string (serialized JSON blob).
 * * `master_key_hex` — 64-char hex-encoded 32-byte master key.
 *
 * Returns base64-encoded obfuscated bytes (safe to transmit as JSON string).
 */
export function obfuscate_blob(plaintext: string, master_key_hex: string): string;

/**
 * Compute an HMAC-SHA256 block seal.
 *
 * * `data` — canonical JSON string to seal.
 * * `master_key_hex` — 64-char hex-encoded 32-byte master key.
 *
 * Returns 64-char hex seal.
 */
export function seal(data: string, master_key_hex: string): string;

/**
 * Compute SHA-256 hash of a string.
 *
 * Returns 64-char lowercase hex string.
 */
export function sha256(data: string): string;

/**
 * Sign data with the identity secret (HMAC-SHA256 signature).
 *
 * * `data` — string to sign (typically a block hash).
 * * `identity_secret_hex` — 64-char hex 32-byte identity secret.
 *
 * Returns 64-char hex signature.
 */
export function sign(data: string, identity_secret_hex: string): string;

/**
 * Verify a device proof.
 */
export function verify_device_proof(device_id: string, proof_hex: string, master_key_hex: string): boolean;

/**
 * Verify an HMAC-SHA256 block seal.
 *
 * * `data` — the original data string.
 * * `seal_hex` — the hex seal to verify.
 * * `master_key_hex` — 64-char hex-encoded 32-byte master key.
 *
 * Returns `true` if the seal is valid, `false` otherwise.
 */
export function verify_seal(data: string, seal_hex: string, master_key_hex: string): boolean;

/**
 * Verify an HMAC-SHA256 identity signature.
 */
export function verify_signature(data: string, signature_hex: string, identity_secret_hex: string): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly authenticate: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly decrypt: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly deobfuscate_blob: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly derive_blob_key: (a: number, b: number) => [number, number, number, number];
    readonly derive_master_key: (a: number, b: number) => [number, number, number, number];
    readonly derive_pdk: (a: number, b: number, c: number) => [number, number];
    readonly derive_seal_key: (a: number, b: number) => [number, number, number, number];
    readonly device_proof: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly encrypt: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly generate_device_specifier: () => [number, number];
    readonly generate_seed: () => [number, number];
    readonly generate_uuid_v4: () => [number, number];
    readonly get_device_id: (a: number, b: number) => [number, number, number, number];
    readonly obfuscate_blob: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly seal: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly sha256: (a: number, b: number) => [number, number];
    readonly sign: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly verify_device_proof: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly verify_seal: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly verify_signature: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
