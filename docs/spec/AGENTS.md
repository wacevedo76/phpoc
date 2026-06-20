# Format Specification

## Purpose
Canonical format specification for the Personal History Protocol (PHPOC) — block structure, encryption scheme, key derivation, chain validation, content hashing, and auxiliary data structures.

## Ownership
- `PHPSPEC.md` — The standalone protocol specification document

## Local Contracts
- `PHPSPEC.md` is the authoritative definition of the ledger format
- Implementations (CLI, web, mobile) must conform to this spec
- Versioned via `format_version` field; migration scripts live in `scripts/`

## Work Guidance
- Changes to the spec must be versioned and documented in the changelog
- Cross-reference design goals in `../design/DESIGN_GOALS.md` for architectural mandates
- Breaking changes require a migration path and version bump

## Verification
None — the spec is verified indirectly through conformance tests in `tests/`.

## Child DOX Index
None — flat directory.
