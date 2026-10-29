# Contributing

Thanks for your interest in the AI Onboarding Kit.

## Development setup

Zero dependencies — everything runs on Node.js stdlib.

- **Requirements:** Node.js >= 18 (for `node --test` and the kit binaries), plus bash + jq on Unix or PowerShell 5.1+ on Windows for the scaffold scripts.
- **Tests:** `node --test tests/*.test.mjs` (POSIX) or `node --test tests\*.test.mjs` (Windows) — every suite is hermetic (temp dirs, redirected HOME). Run the whole suite before submitting.
- **Single source of truth:** `onboard.manifest.json` drives skills, templates, placeholders, and MCP servers. Extend the kit by editing the manifest, not the scripts.

## What you may commit

- Kit machinery: `bin/`, `scaffold.*`, `templates/`, `prompts/`, `onboard.manifest.json`, `tests/`, `docs/`.
- **Never** commit personal state: `profiles.user.json`, `projects.registry.json`, or anything matching `.gitignore`. User files stay local by design — copy `profiles.user.json.example` if you need a starting point.
- Keep real values out of tests and templates: use `{{PLACEHOLDER}}` tokens, temp paths, and synthetic data only.

## Pull requests

- One change per PR; keep the manifest the single source of truth (design principle #1 in the README).
- Sync-engine changes must preserve the "no phantom conflicts" invariants documented in `docs/specs/` and `docs/research/`.
- Bug fixes: include a regression test that fails before and passes after.

## Reporting issues

Open an issue with your OS, Node version, and the scaffold/sync output (redact paths as needed). Please enable GitHub secret scanning on forks — the kit is designed to keep secrets in ignored local files.
