# Reference Documentation

## Purpose
Reference artifacts for the PHPOC project — changelog, project map, and other durable reference material consulted during development and onboarding.

## Ownership
- `CHANGELOG.md` — Versioned release history
- `MAP.md` — Project file inventory, architecture invariants, quick-reference commands

## Local Contracts
- `CHANGELOG.md` tracks only tagged, released versions; WIP lives in `../planning/` and `../../SESSION_HANDOFF.md`
- `MAP.md` documents the current project structure — update when files are added, moved, or deleted
- Architecture invariants in `MAP.md` are binding across all layers

## Work Guidance
- Add changelog entries on release, referencing ADRs where applicable
- Update `MAP.md` file inventory when source files change
- Quick-reference commands must stay accurate for `main.py` and `pytest`

## Verification
None — reference docs are informational, not tested.

## Child DOX Index
None — flat directory.
