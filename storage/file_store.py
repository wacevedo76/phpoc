import json
from pathlib import Path

class LedgerStore:
    def __init__(self, staging_path: Path, ledger_path: Path):
        self.staging_path = staging_path
        self.ledger_path = ledger_path
        self._ensure_paths()
        if not self.staging_path.exists():
            self.write_staging([])

    def _ensure_paths(self):
        self.staging_path.parent.mkdir(parents=True, exist_ok=True)

    def read_staging(self):
        if not self.staging_path.exists():
            return []
        return json.loads(self.staging_path.read_text())

    def write_staging(self, data):
        self.staging_path.write_text(json.dumps(data, indent=2))

    def read_ledger(self):
        if not self.ledger_path.exists():
            return None
        return json.loads(self.ledger_path.read_text())

    def write_ledger(self, data):
        self.ledger_path.write_text(json.dumps(data, indent=2))
