#!/usr/bin/env bash
# Check remote ledger blocks count
# Usage: ./scripts/check_remote_ledger.sh

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

blocks = transport.list_files('blocks/')
if not blocks:
    print('No remote blocks found')
    exit(0)

print(f'{len(blocks)} remote blocks')
indices = sorted(int(b.split('/')[-1].split('.')[0]) for b in blocks)
print(f'Indices: min={min(indices)}, max={max(indices)}')
print(f'Sample: {indices[:5]}...{indices[-3:]}')
"
