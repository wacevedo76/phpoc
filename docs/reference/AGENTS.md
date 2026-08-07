# Reference Documentation

## Purpose
Reference artifacts for the PHPOC project — changelog, project map, and other durable reference material consulted during development and onboarding.

## Ownership
- `CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` — **Primary reference** for local/remote staging sync and reconciliation across all clients (CLI, Web, Flutter). Protocol contracts, sync flow, merge engine, blob obfuscation, device cookie, hash index, row-level sync (ADR-025), source code index, test coverage map.
- `CHANGELOG.md` — Versioned release history
- `MAP.md` — Project file inventory, architecture invariants, quick-reference commands
- `DEVICE_COOKIE_AND_STAGING_DATABASE_SCHEMA.md` — Device Cookie and Staging Database Schema cross-client reference (detailed schema; see CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md for protocol-level overview)

## Local Contracts
- `CHANGELOG.md` tracks only tagged, released versions; WIP lives in `../planning/` and `../../SESSION_HANDOFF.md`
- `MAP.md` documents the current project structure — update when files are added, moved, or deleted
- Architecture invariants in `MAP.md` are binding across all layers

## Work Guidance
- **Staging sync changes**: Update `CROSS_CLIENT_STAGE_SYNCING_REFERENCE.md` when sync protocol, merge rules, or cross-client contracts change. This is the living reference for all staging sync work.
- **Implementation planning**: For CCS implementation status, per-client deliverables, and phased rollout, see `../planning/CROSS_CLIENT_REMOTE-LOCAL_STAGING_SYNC-RECONCILIATION_PLAN.md`.
- Add changelog entries on release, referencing ADRs where applicable
- Update `MAP.md` file inventory when source files change
- Quick-reference commands must stay accurate for `main.py` and `pytest`

## Verification
None — reference docs are informational, not tested.

## Child DOX Index
None — flat directory.
