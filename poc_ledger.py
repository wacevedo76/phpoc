import json
import hashlib
import subprocess
import os
import time
from pathlib import Path

# Configuration
CONFIG_DIR = Path.home() / ".config" / "personal_history_poc"
STAGING_FILE = CONFIG_DIR / "staging.json"
LEDGER_FILE = CONFIG_DIR / "ledger.json"

CONFIG_DIR.mkdir(parents=True, exist_ok=True)

class OpenSSLProvider:
    """Provides encryption using system OpenSSL."""
    def __init__(self, password):
        self.password = password

    def encrypt(self, text):
        # -aes-256-cbc: Strong encryption
        # -a: Base64 output (concise text)
        # -salt: Protection against dictionary attacks
        # -pbkdf2: Modern key derivation standard
        process = subprocess.Popen(
            ["openssl", "enc", "-aes-256-cbc", "-a", "-salt", "-pbkdf2", "-pass", f"pass:{self.password}"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        stdout, stderr = process.communicate(input=text)
        if process.returncode != 0:
            raise Exception(f"OpenSSL Error: {stderr}")
        return stdout.strip()

    def decrypt(self, encrypted_text):
        """Helper for future verification/reveal features"""
        process = subprocess.Popen(
            ["openssl", "enc", "-aes-256-cbc", "-d", "-a", "-pbkdf2", "-pass", f"pass:{self.password}"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True
        )
        stdout, stderr = process.communicate(input=encrypted_text)
        if process.returncode != 0:
            raise Exception(f"OpenSSL Error: {stderr}")
        return stdout.strip()

class POCLedger:
    def __init__(self, encryptor):
        self.encryptor = encryptor # This is the modular provider
        self._init_files()

    def _init_files(self):
        if not STAGING_FILE.exists():
            STAGING_FILE.write_text(json.dumps([]))
        if not LEDGER_FILE.exists():
            genesis = {
                "day_index": 0,
                "prev_hash": "0" * 64,
                "day_hash": "0" * 64,
                "entries": []
            }
            LEDGER_FILE.write_text(json.dumps([genesis]))

    def capture_habit(self, title, start_epoch, stop_epoch, metadata=None):
        print(f"Capturing: {title}...")
        
        # Use the modular encryptor
        enc_start = self.encryptor.encrypt(str(start_epoch))
        enc_stop = self.encryptor.encrypt(str(stop_epoch))
        
        entry = {
            "title": title,
            "start_time_enc": enc_start,
            "stop_time_enc": enc_stop,
            "duration": stop_epoch - start_epoch,
            "metadata": metadata or {}
        }
        
        entry_json = json.dumps(entry, sort_keys=True)
        entry_hash = hashlib.sha256(entry_json.encode()).hexdigest()
        
        packaged_entry = {
            "hash": entry_hash,
            "data": entry
        }
        
        staging = json.loads(STAGING_FILE.read_text())
        staging.append(packaged_entry)
        STAGING_FILE.write_text(json.dumps(staging, indent=2))
        print(f"✓ Staged with hash: {entry_hash[:10]}...")

    def sync_day(self):
        staging = json.loads(STAGING_FILE.read_text())
        if not staging:
            print("Nothing to sync.")
            return

        ledger = json.loads(LEDGER_FILE.read_text())
        prev_day = ledger[-1]
        
        new_day_index = prev_day["day_index"] + 1
        date_str = time.strftime("%Y-%m-%d")
        
        day_content = {
            "day_index": new_day_index,
            "date": date_str,
            "prev_hash": prev_day["day_hash"],
            "entries": staging
        }
        
        day_json = json.dumps(day_content, sort_keys=True)
        day_hash = hashlib.sha256(day_json.encode()).hexdigest()
        day_content["day_hash"] = day_hash
        
        ledger.append(day_content)
        LEDGER_FILE.write_text(json.dumps(ledger, indent=2))
        STAGING_FILE.write_text(json.dumps([]))
        print(f"✓ Day {new_day_index} committed. Hash: {day_hash[:10]}...")

    def verify_ledger(self):
        ledger = json.loads(LEDGER_FILE.read_text())
        print("Verifying Ledger Integrity...")
        
        for i in range(1, len(ledger)):
            current = ledger[i]
            prev = ledger[i-1]
            
            if current["prev_hash"] != prev["day_hash"]:
                print(f"✗ GAP DETECTED at Day {current['day_index']}!")
                return False
            
            check_data = {k: v for k, v in current.items() if k != "day_hash"}
            check_json = json.dumps(check_data, sort_keys=True)
            if hashlib.sha256(check_json.encode()).hexdigest() != current["day_hash"]:
                print(f"✗ TAMPERING DETECTED at Day {current['day_index']}!")
                return False
                
            for entry in current["entries"]:
                if hashlib.sha256(json.dumps(entry["data"], sort_keys=True).encode()).hexdigest() != entry["hash"]:
                    print(f"✗ ENTRY TAMPERING in Day {current['day_index']}!")
                    return False

        print("✅ Ledger is 100% Authentic.")
        return True

if __name__ == "__main__":
    import sys
    
    # In a real app, this password might be stored in the OS keyring
    # For POC, we'll use a placeholder or prompt
    PASSPHRASE = "poc-secret-key" 
    
    encryptor = OpenSSLProvider(PASSPHRASE)
    poc = POCLedger(encryptor)
    
    if len(sys.argv) < 2:
        print("Usage: python poc_ledger.py [add|sync|verify]")
        sys.exit(1)
        
    cmd = sys.argv[1]
    if cmd == "add":
        title = input("Habit Title: ")
        start = int(time.time()) - 120
        stop = int(time.time())
        poc.capture_habit(title, start, stop)
    elif cmd == "sync":
        poc.sync_day()
    elif cmd == "verify":
        poc.verify_ledger()
