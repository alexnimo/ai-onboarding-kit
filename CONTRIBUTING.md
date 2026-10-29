# Contributing

Thanks for your interest in the AI Onboarding Kit.

## Development setup

Zero dependencies — everything runs on Node.js stdlib.

- **Requirements:** Node.js >= 18 (for `node --test` and the kit binaries), plus bash + jq on Unix or PowerShell 5.1+ on Windows for the scaffold scripts.
- **Tests:** `node --test tests/*.test.mjs` (POSIX) or `node --test tests\*.test.mjs` (Windows) — every suite is hermetic (temp dirs, redirected HOME). Run the whole suite before submitting.
- **Single source of truth:** `onboard.manifest.json` drives skills, templates, placeholders, and MCP servers. Extend the kit by editing the manifest, not the scripts.

## Dogfooding: stable checkout + dev clone (recommended)

The kit runs straight from a git clone — no install step. That means uncommitted changes in your dev clone are the code that runs when you onboard a real project. Recommended setup: **develop in one clone, run the kit from a second worktree pinned to committed `main`.**

```bash
# One-time: create the stable copy next to your dev clone
git worktree add --detach ../aok-stable main

# Copy your personal state so the stable copy owns the live registry
cp projects.registry.json profiles.user.json ../aok-stable/
```

Daily flow:

```bash
# 1. Develop in the dev clone, commit to main
git commit -am "feat: ..."

# 2. Release to production: fast-forward the stable worktree
git -C ../aok-stable merge --ff-only main

# 3. Publish the same commit publicly (optional, independent step)
git push origin main
```

Why this is safe:

- The worktree is detached at a commit — your uncommitted WIP physically can't affect it.
- `merge --ff-only` only touches tracked files; `projects.registry.json` and `profiles.user.json` are ignored, so your project inventory survives every update.
- Releasing to production and pushing publicly are independent — you can ship locally without publishing.

Rules:

- Always run real projects through the stable copy (`node ../aok-stable/bin/onboard.mjs …`); use the dev clone's `bin/` only for tests. The kit records state relative to whichever `bin/` ran it — mixing them forks your registry.
- Back up `aok-stable/projects.registry.json` + `profiles.user.json` occasionally; they are the only record of onboarded projects and they live outside version control by design.

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
