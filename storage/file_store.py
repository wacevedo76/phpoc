from storage.interface import AbstractLedgerStore
import json
from pathlib import Path
from typing import List, Dict, Any, Optional

class LedgerStore(AbstractLedgerStore):
    def __init__(self, staging_path: Path, ledger_path: Path, index_path: Optional[Path] = None):
        self.staging_path = staging_path
        self.ledger_path = ledger_path
        self.index_path = index_path or ledger_path.with_name("index.json")
        self._ensure_paths()
        if not self.staging_path.exists():
            self.write_staging([])

    def _ensure_paths(self):
        self.staging_path.parent.mkdir(parents=True, exist_ok=True)

    def read_staging(self) -> List[Dict[str, Any]]:
        if not self.staging_path.exists():
            return []
        return json.loads(self.staging_path.read_text())

    def write_staging(self, data: List[Dict[str, Any]]):
        self.staging_path.write_text(json.dumps(data, indent=2))

    def read_ledger(self) -> Optional[List[Dict[str, Any]]]:
        if not self.ledger_path.exists():
            return None
        return json.loads(self.ledger_path.read_text())

    def write_ledger(self, data: List[Dict[str, Any]]):
        self.ledger_path.write_text(json.dumps(data, indent=2))

    def read_index(self) -> Dict[str, Any]:
        if not self.index_path.exists():
            return {}
        return json.loads(self.index_path.read_text())

    def write_index(self, data: Dict[str, Any]):
        self.index_path.write_text(json.dumps(data, indent=2))

    def read_identity(self) -> Optional[Dict[str, Any]]:
        id_path = self.ledger_path.parent / "identity.json"
        if not id_path.exists(): return None
        return json.loads(id_path.read_text())

    def write_identity(self, data: Dict[str, Any]):
        id_path = self.ledger_path.parent / "identity.json"
        id_path.write_text(json.dumps(data, indent=2))
