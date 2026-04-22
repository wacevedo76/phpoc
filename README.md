# PH Ledger (phpoc)

**PH Ledger** is a modular, zero-dependency reputation engine built for privacy-first personal history tracking. It uses a sovereign cryptographic architecture to ensure that your data is immutable, verifiable, and owned entirely by you.

## 🚀 Key Features

### 1. Sovereign Security Model
- **Seed-Rooted Trust:** All encryption and seals are rooted in a 256-bit **Recovery Seed**. Your passphrase acts only as a "Vault Key" to unlock the seed.
- **Identity & Provenance:** Every ledger block is signed by a unique local **Identity Key** (Ed25519-proxy), ensuring that only you can authorize updates to your history.
- **Zero-Knowledge:** No external server or developer can access your data. Only the holder of the Master Key can decrypt and verify the ledger.

### 2. Privacy-First Architecture
- **Pattern-of-Life Protection:** Precise `startTime` and `endTime` timestamps are encrypted at rest to prevent behavioral profiling by bad actors.
- **Blind Duration Indexing:** A secondary `index.json` aggregates task durations by date, enabling lightning-fast reputation queries without decrypting your private history.
- **RAM-Backed Sessions:** Uses a secure session cache (`/dev/shm`) to provide a "once-per-session" authentication experience.

### 3. Cryptographic Integrity
- **Hierarchical Lock Chain:** A nested chain of trust where the **Genesis** locks the **Year**, the Year locks the **Month**, and the Month locks the **Day**, which finalizes individual tasks.
- **Tamper Evidence:** Any modification to historical records triggers a verification failure across the entire downstream chain.
- **Partitionable Ledger:** Supports truncation and archival (e.g., moving a year's data to a separate file) without breaking the cryptographic thread.

## 🛠 Use Cases

- **Proof of Habit:** Generate cryptographically signed reports of your activities (e.g., "I practiced guitar for 500 hours this year") that can be verified by third parties or AI agents.
- **Universal Reputation Engine:** A "Headless Engine" that can be integrated into Desktop, Mobile (React Native), Web (Django), or even wearable devices.
- **Content Authenticity:** (Roadmap) Link content hashes of media (video, audio, photos) to specific activities to prove when and where a piece of content was created.
- **Data Sovereignty:** Own your history in a platform-independent JSON format that can be reconstructed from its constituent blocks even if the master file is lost.

## 🏁 Getting Started

### Installation
Clone the repository and ensure you have Python 3.x installed. No external dependencies are required.

```bash
export PYTHONPATH=$PYTHONPATH:.
```

### 1. Initialize your Ledger
Create your identity and generate your Recovery Seed. **Save the seed in a secure place!**
```bash
python3 main.py init
```

### 2. Track Activities
```bash
# Start a task
python3 main.py add start "Deep Work"

# End a task
python3 main.py add end "Deep Work"

# View active tasks
python3 main.py view
```

### 3. Sync & Seal
Finalize your staged activities into the immutable ledger.
```bash
python3 main.py sync
```

### 4. Analyze Reputation
```bash
# Fast, private reputation summary
python3 main.py rep

# Detailed decrypted history
python3 main.py list
```

## 🛠 Development & Testing
The project uses a RAM-backed disk integration test suite.
```bash
export PYTHONPATH=$PYTHONPATH:.
python3 tests/test_modular.py
python3 tests/test_recovery.py
python3 tests/test_hierarchy.py
```

## 📜 License
Licensed under the Apache License, Version 2.0 (the "License"). See the [LICENSE](LICENSE) file for details.
