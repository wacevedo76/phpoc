from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional
from pathlib import Path

class AbstractLedgerStore(ABC):
    @abstractmethod
    def read_staging(self) -> List[Dict[str, Any]]:
        pass

    @abstractmethod
    def write_staging(self, data: List[Dict[str, Any]]):
        pass

    @abstractmethod
    def read_ledger(self) -> Optional[List[Dict[str, Any]]]:
        pass

    @abstractmethod
    def write_ledger(self, data: List[Dict[str, Any]]):
        pass

    @abstractmethod
    def read_index(self) -> Dict[str, Any]:
        pass

    @abstractmethod
    def write_index(self, data: Dict[str, Any]):
        pass

    @abstractmethod
    def read_identity(self) -> Optional[Dict[str, Any]]:
        pass

    @abstractmethod
    def write_identity(self, data: Dict[str, Any]):
        pass
