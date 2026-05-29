#!/usr/bin/env bash
# Check remote blob: show entries from the R2 staging blob
# Usage: ./scripts/check_remote_blob.sh

cd "$(dirname "$0")/.."

python3 -c "
from storage.implementations.file_config import _resolve_data_dir, _resolve_config_path, FileConfigStore
from security.config_manager import ConfigManager
from core.sync.transport import create_transport_from_config

config_path = _resolve_config_path()
config_store = FileConfigStore(config_path)
config = ConfigManager(config_store)
data_dir = _resolve_data_dir(config_manager=config)
config_with_dir = dict(config.read())
config_with_dir['_config_dir'] = str(data_dir)
transport = create_transport_from_config(config_with_dir)

# Try with cached session key
from pathlib import Path
session = Path('/dev/shm/phpoc_session')
if session.exists():
    key = session.read_bytes()
    print(f'Session key: {key.hex()[:16]}...')
else:
    print('No cached session key')
    key = None

raw = transport.pull('staging/blobs/current.json')
if raw is None:
    print('No remote blob found')
    exit(0)

from domain.staging.remote_sync import RemoteStagingSync

if key:
    decrypted = RemoteStagingSync._deobfuscate(raw, key)
    if decrypted:
        import struct
        ol = struct.unpack('>I', decrypted[:4])[0]
        print(f'Deobfuscation OK, original_len={ol}')
        if ol < 100000:
            import json
            payload = decrypted[4:4+ol]
            data = json.loads(payload.decode('utf-8'))
            print(f'{len(data)} entries')
            for e in data:
                d = e.get('data', {})
                active = d.get('is_active', False)
                title = d.get('title', '?')
                print(f'  [{\"A\" if active else \" \"}] {title}')
        else:
            print(f'Original length {ol} is unreasonable — wrong key')
    else:
        print('Deobfuscation failed')
"
