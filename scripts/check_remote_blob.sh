#!/usr/bin/env bash
# Check remote blob: show entries from the R2 staging blob
# Usage: ./scripts/check_remote_blob.sh

cd "$(dirname "$0")/.."

python3 << 'PYEOF'
import json
import struct
from pathlib import Path

from storage.implementations.file_config import _resolve_data_dir, _resolve_config_path, FileConfigStore
from security.config_manager import ConfigManager
from core.sync.transport import create_transport_from_config

def try_keys(raw, keys):
    """Try multiple master keys to deobfuscate the blob.

    RemoteStagingSync._deobfuscate() strips the 4-byte length prefix
    and returns the plaintext directly. The return value IS the
    original blob JSON bytes.
    """
    from domain.staging.remote_sync import RemoteStagingSync

    for label, key in keys:
        if key is None:
            continue
        plaintext = RemoteStagingSync._deobfuscate(raw, key)
        if plaintext is not None:
            try:
                data = json.loads(plaintext.decode('utf-8'))
                entries = data.get('entries', [])
                print(f"✅ {label}: Deobfuscation OK, {len(entries)} entries, {len(plaintext)} bytes")
                for e in entries:
                    d = e.get('data', {})
                    active = d.get('is_active', False)
                    title = d.get('title', '?')
                    print(f"    [{'A' if active else ' '}] {title}")
                print(f"    Device: {data.get('device_id', '?')}, Updated: {data.get('updated_at', '?')}")
                return True
            except json.JSONDecodeError:
                print(f"⚠️  {label}: Decrypted but not valid JSON ({len(plaintext)} bytes)")
        else:
            print(f"❌ {label}: Deobfuscation failed")
    return False

# Build transport from config
config_path = _resolve_config_path()
config_store = FileConfigStore(config_path)
config = ConfigManager(config_store)
data_dir = _resolve_data_dir(config_manager=config)
config_with_dir = dict(config.read())
config_with_dir['_config_dir'] = str(data_dir)
transport = create_transport_from_config(config_with_dir)

# Pull raw blob
raw = transport.pull('staging/blobs/current.json')
if raw is None:
    print("No remote blob found (pull returned None)")
    exit(0)

print(f"Remote blob: {len(raw)} bytes")
print()

# Collect candidate keys
keys = []

# 1. Cached session key
session = Path('/dev/shm/phpoc_session')
if session.exists():
    keys.append(("session key", session.read_bytes()))
else:
    print("No cached session key (run 'ph login' first)")

# 2. Known master key from session handoff
known_mk = bytes.fromhex('00fb89ef9116b5e0899bd8b1d3fc4763efc9a2345e85c5f0651e578905a6794d')
keys.append(("known MK 00fb89ef...", known_mk))

print("Attempting deobfuscation...")
print()
if not try_keys(raw, keys):
    print()
    print("❌ Could not decrypt remote blob with any available key.")
    print("   The blob may be garbled or corrupted. Try:")
    print("   1. ph login  (re-authenticate with correct passphrase)")
    print("   2. Then re-run this script")
    exit(1)
PYEOF
