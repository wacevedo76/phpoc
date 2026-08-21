#!/usr/bin/env python3
"""Verify the integrity of a PH ledger chain.

Mirrors phpoc-flutter/lib/data/ledger/chain.dart `verify()` plus the crypto from
`sealable_chain.dart` / `helpers.dart`, so a ledger can be validated offline
against the same checks the app runs (Settings → Verify Ledger).

Checks, in order (first failure short-circuits):
  1. prev_hash linkage across all blocks
  2. per-block internal seal (HMAC-SHA256 over ADR-029a seal-field whitelist)
  3. identity_seal (HMAC-SHA256 signature, requires identity secret)
  4. entry hash (3-way serialization fallback)
  5. content_hash (decrypt `_enc` fields via AES-128-CTR, canonical jsonSort)
  6. key_version invariant (day blocks must not exceed genesis key_version)

Notes:
- Seal + identity + content_hash checks need the master key. Provide it with
  --mk-hex (64-hex) or --seed (base64 32-byte recovery seed; the seed bytes ARE
  the master key). Linkage / entry-hash checks need no key and always run.
- Content-hash checks need the `cryptography` package.

Usage:
    python3 scripts/verify_ledger.py <ledger.json> [--mk-hex HEX | --seed B64]
                                          [--identity-secret HEX] [--verbose]
Supports raw-chain arrays and the v2 export dict ({...'ledger': [...]}).
"""
import argparse
import hashlib
import hmac
import json
import sys

# ── Imports & helpers ───────────────────────────────────────────
try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    HAVE_CRYPT = True
except ImportError:
    HAVE_CRYPT = False


def _hex(s):
    return bytes.fromhex(s)


def _js(o):
    """Canonical leaf JSON literal (overrides only attr of value being encoded)."""
    return o


def json_sort(d):
    """Mirror Flutter jsonSort: keys sorted at every level, `, ` / `: ` — matches
    Python json.dumps(sort_keys=True)."""
    return json.dumps(d, sort_keys=True, ensure_ascii=False)


def _json_sort_pretty(d, depth=0):
    indent = '  ' * (depth + 1)
    outer = '  ' * depth
    if isinstance(d, list):
        if not d:
            return '[]'
        return '[\n' + ',\n'.join(indent + _json_sort_pretty(v, depth + 1) for v in d) + '\n' + outer + ']'
    if isinstance(d, dict):
        if not d:
            return '{}'
        keys = sorted(d.keys())
        pairs = ',\n'.join(indent + json.dumps(k) + ': ' + _json_sort_pretty(d[k], depth + 1) for k in keys)
        return '{\n' + pairs + '\n' + outer + '}'
    return json.dumps(d)


def _json_dumps(o):
    if isinstance(o, str):
        return json.dumps(o)
    return o


def _hmac(key, data):
    # `key` may be bytes, a 64-char hex string (mk), or the 64-hex seal-key string
    if isinstance(key, str):
        kb = bytes.fromhex(key)
    else:
        kb = key
    return hmac.new(kb, data if isinstance(data, bytes) else data.encode('utf-8'),
                    hashlib.sha256).digest()


def _aes_ctr(data, key16, nonce8):
    if not HAVE_CRYPT:
        raise RuntimeError('`cryptography` package required for content-hash verify')
    iv = nonce8 + bytes(8)  # 8-byte nonce padded to 16, big-endian CTR counter
    dec = Cipher(algorithms.AES(key16), modes.CTR(iv)).decryptor()
    return dec.update(data) + dec.finalize()


def decrypt_field(ciphertext_hex, mk_hex):
    """Canonical PHPSPEC §3 decrypt: salt(16)‖nonce(8)‖ct‖tag(32), hex-encoded."""
    data = _hex(ciphertext_hex)
    if len(data) < 56:
        salt, nonce, ct = data[:16], data[16:24], data[24:]
        return _aes_ctr(ct, _hmac(mk_hex, salt)[:16], nonce)
    salt, nonce = data[:16], data[16:24]
    tag, ct = data[-32:], data[24:-32]
    aes_key = _hmac(mk_hex, salt)[:16]
    int_key = _hmac(mk_hex, salt + b'-integrity')[:32]
    if hmac.compare_digest(_hmac(int_key, nonce + ct), tag):
        return _aes_ctr(ct, aes_key, nonce)
    # legacy Flutter fallback: raw mk[:16]
    fk = _hex(mk_hex)[:16]
    if hmac.compare_digest(_hmac(_hmac(fk, salt + nonce + ct)[:32], nonce + ct), tag):
        return _aes_ctr(ct, fk, nonce)
    # Python-compatible no-tag fallback (pre-0.4.0 forms). Mirror Flutter
    # CryptoService.decrypt(): when the canonical HMAC tag does not verify,
    # treat ALL bytes after salt(16)+nonce(8) as ciphertext (data[24:], i.e.
    # the trailing 32 bytes are ciphertext, NOT a tag) and decrypt with the
    # canonical salt-derived key. Earlier code wrongly stripped data[-32:]
    # as a 'tag', truncating the plaintext and producing a divergent
    # content_hash → false 'INVALID' verdicts.
    return _aes_ctr(data[24:], aes_key, nonce)


def verify_content_hash(data, expected_hash, mk_hex):
    """Mirror Flutter verifyContentHash (helpers.dart)."""
    canonical = _build_canonical_map(data, mk_hex)
    canonical.pop('content_hash', None)
    if hashlib.sha256(json_sort(canonical).encode()).hexdigest() == expected_hash:
        return True
    if hashlib.sha256(_json_sort_pretty(canonical).encode()).hexdigest() == expected_hash:
        return True
    return False


def _sort_list(vals):
    try:
        return sorted(vals)
    except TypeError:
        return sorted(vals, key=str)


def _build_canonical_map(data, mk_hex):
    canonical = {}
    for key, value in data.items():
        k = key
        if key.endswith('_enc') and isinstance(value, str) and value:
            k = key[:-4]
            try:
                value = decrypt_field(value, mk_hex).decode('utf-8')
            except Exception:
                pass  # keep raw ciphertext
        if isinstance(value, list):
            value = _sort_list(value)
        canonical[k] = value
    return canonical


# ── Sealing ────────────────────────────────────────────────────
def seal_key_hex(mk_hex):
    return _hmac(mk_hex, 'integrity-key-salt').hex()  # PHPSPEC §5.2


def seal(data, mk_hex):
    return _hmac(seal_key_hex(mk_hex), data).hex()  # derived seal key


def seal_raw_mk(data, mk_hex):
    return _hmac(mk_hex, data).hex()  # legacy raw-MK fallback


# ── Chain loading & block helpers ──────────────────────────────
def load_chain(path):
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    if isinstance(data, dict) and 'ledger' in data:
        return data['ledger']
    if isinstance(data, list):
        return data
    raise ValueError(f'Unknown ledger format: {type(data).__name__}')


def get_block_hash(block):
    for k in ('block_hash', 'day_hash', 'month_hash', 'year_hash'):
        if block.get(k):
            return block[k]
    return ''


def hash_key_of(btype):
    return {'genesis': 'block_hash', 'day': 'day_hash',
            'month_summary': 'month_hash', 'year_summary': 'year_hash'}.get(btype)


SEAL_FIELDS = {
    'genesis': ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash'],
    'day': ['type', 'day_index', 'date', 'prev_hash', 'entries', 'original_hash'],
    'month_summary': ['type', 'month', 'date', 'prev_hash', 'original_hash'],
    'year_summary': ['type', 'year', 'date', 'prev_hash', 'original_hash'],
}


def sha256(s):
    return hashlib.sha256((s if isinstance(s, bytes) else s.encode('utf-8'))).hexdigest()


def entry_hash_ok(data, hashv):
    """3-way entry-hash serialization check (compact, compact-no-space, indent2)."""
    cands = [
        json.dumps(data, sort_keys=True, ensure_ascii=False),
        json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(',', ':')),
        json.dumps(data, sort_keys=False, indent=2, ensure_ascii=False),
    ]
    return any(sha256(c) == hashv for c in cands)


class Verifier:
    def __init__(self, blocks, mk_hex, identity_secret_hex, verbose=False):
        self.blocks = blocks
        self.mk_hex = mk_hex
        self.identity_secret_hex = identity_secret_hex
        self.verbose = verbose

    def log(self, s):
        if self.verbose:
            print('   ', s)

    def verify(self):
        blocks = self.blocks
        if not blocks:
            print('OK: empty chain (no blocks)')
            return True
        genesis = blocks[0]

        # content-hash requirement: absent format_version → treated as 0.4.0
        fv = genesis.get('format_version')
        require_content_hash = True
        if fv is not None:
            def _parts(v):
                if isinstance(v, (list, tuple)):
                    return [int(x) for x in v]
                return [int(x) for x in str(v).split('.') if x.strip().isdigit()]
            require_content_hash = (_parts(fv) >= [0, 4, 0])
        self.log(f'require_content_hash = {require_content_hash}')

        genesis_kv = genesis.get('key_version')
        for i, block in enumerate(blocks):
            btype = block.get('type')

            # 1. prev_hash linkage
            if i > 0:
                prev_hash = get_block_hash(blocks[i - 1])
                if prev_hash and block.get('prev_hash') and block['prev_hash'] != prev_hash:
                    self._fail(i, 'prev_hash linkage',
                               f'stored={block["prev_hash"][:16]} expected={prev_hash[:16]}')
                    return False

            # 2. block seal (needs MK; missing stored seal key = failure)
            hk = hash_key_of(btype)
            if hk is None:
                self._fail(i, 'unknown block type', btype)
                return False
            stored_seal = block.get(hk)
            if not stored_seal:
                self._fail(i, f'missing seal key {hk}', None)
                return False
            fields = SEAL_FIELDS.get(btype, [])
            seal_data = {f: block[f] for f in fields if f in block}
            seal_json = json_sort(seal_data)
            if self.mk_hex:
                ok = (stored_seal == seal(seal_json, self.mk_hex)
                      or stored_seal == seal_raw_mk(seal_json, self.mk_hex))
                if not ok:
                    self._fail(i, 'block seal', f'{hk} {stored_seal[:16]}... does not verify')
                    return False

            # 3. identity_seal
            if self.identity_secret_hex and block.get('identity_seal'):
                bh = block.get(hk)
                sig = _hmac(self.identity_secret_hex, bh).hex()
                if block['identity_seal'] != sig:
                    self._fail(i, 'identity_seal', 'signature mismatch')
                    return False

            # 4/5. entry hashes + content hashes (day blocks)
            if btype == 'day':
                for j, e in enumerate(block.get('entries', []) or []):
                    if not isinstance(e, dict):
                        self._fail(i, f'entry {j} not a map', repr(e))
                        return False
                    data = e.get('data')
                    hashv = e.get('hash')
                    if not isinstance(data, dict) or not hashv:
                        self._fail(i, f'entry {j} missing data/hash', None)
                        return False
                    if not entry_hash_ok(data, hashv):
                        self._fail(i, f'entry {j} hash mismatch',
                                   f'hash={hashv[:16]} data keys={list(data.keys())}')
                        return False
                    if require_content_hash and self.mk_hex:
                        ch = data.get('content_hash')
                        if ch:
                            if not verify_content_hash(data, ch, self.mk_hex):
                                self._fail(i, f'entry {j} content_hash mismatch',
                                           f'ch={ch[:16]}')
                                return False

            # 6. key_version invariant
            if genesis_kv is not None and btype == 'day':
                bk = block.get('key_version')
                if bk is not None and bk > genesis_kv:
                    self._fail(i, 'key_version invariant', f'{bk} > genesis {genesis_kv}')
                    return False

            self.log(f'block {i} ({btype}) OK')
        print('VALID: chain verifies (%d blocks)' % len(blocks))
        return True

    def _fail(self, i, check, detail):
        block = self.blocks[i]
        print(f'INVALID at block index {i} [{check}]: {detail} '
              f'(type={block.get("type")}, date={block.get("date")})')


def main():
    ap = argparse.ArgumentParser(description='Verify a PH ledger chain.')
    ap.add_argument('ledger_file')
    ap.add_argument('--seed', help='base64 32-byte recovery seed (SEED == master key bytes)')
    ap.add_argument('--mk-hex', help='32-byte master key as 64-char hex')
    ap.add_argument('--identity-secret')
    ap.add_argument('-v', '--verbose', action='store_true')
    args = ap.parse_args()

    blocks = load_chain(args.ledger_file)
    mk_hex = None
    if args.mk_hex:
        mk_hex = args.mk_hex.lower()
    elif args.seed:
        import base64
        sd = base64.b64decode(args.seed)
        if len(sd) != 32:
            print(f'ERROR: seed decodes to {len(sd)} bytes, expected 32', file=sys.stderr)
            sys.exit(2)
        mk_hex = sd.hex()

    v = Verifier(blocks, mk_hex, args.identity_secret, args.verbose)
    ok = v.verify()
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
