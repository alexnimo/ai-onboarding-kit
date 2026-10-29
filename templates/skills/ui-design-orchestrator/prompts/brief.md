# Brief template

> The canonical brief. Passed verbatim to every lane in `explore` mode and used
> as the intake form in `single` / `lifecycle` modes. Fill every field; mark
> unknowns as TBD and ask the user one question at a time to resolve them.

## Step 0 — Read existing context (before asking the user anything)

Before collecting the brief, check for existing context files and read them:

1. **`PRODUCT.md`** (project root, created by `/impeccable init`) — platform,
   users, purpose, positioning, evidence, brand commitments. If present, pull
   `audience`, `quiet_constraints`, and `surface` (platform) from it instead of
   asking.
2. **`DESIGN.md`** (project root, created by `/impeccable document`) — colors,
   type, components, radii, design rules. If present, pull `brand_assets` and
   `vibe_words` from it instead of asking.
3. **`.agents/PRD.md`** (kit's product doc) — link to PRODUCT.md for product
   info. If PRODUCT.md is missing, PRD.md is the fallback for `audience` and
   `quiet_constraints`.
4. **`.impeccable/surfaces/<page>.md`** (per-surface briefs) — if a brief
   already exists for this surface, reuse it instead of re-intaking.

If impeccable is installed and PRODUCT.md / DESIGN.md are missing, run phase 1
(`/impeccable init` + `/impeccable document`) before collecting the brief —
`shape` will do the discovery interview and produce the brief for you.

Only ask the user for fields that cannot be inferred from existing context.

## Brief

- **Page kind:** (landing / portfolio / redesign / app_screen / editorial / docs
  / gallery / other — see mode mapping below)
- **Surface:** (web / mobile — from PRODUCT.md `## Platform` if present)
- **Audience:** (who scans this and what they want — from PRODUCT.md if present)
- **Vibe words:** (the words the user used — "minimalist", "Linear-style",
  "Awwwards", "premium consumer", "brutalist", etc. — from DESIGN.md if present)
- **Reference signals:** (URLs, screenshots, products, brands the user named)
- **Brand assets that already exist:** (logo, color, type, photography — from
  DESIGN.md if present; for redesigns these are starting material, not optional)
- **Quiet constraints:** (accessibility-first, public-sector, regulated, kids'
  products — from PRODUCT.md if present; these OVERRIDE aesthetic preference)
- **Content:** (the actual copy/sections the page must contain, or "TBD — infer
  from brief")
- **Mode:** (single / explore / lifecycle / audit)
- **Number of options (explore only):** (default 3)
- **Per-lane models (explore only):** (default `pool:webdesign`; exact labels or `pool:<name>` refs — see `MODELS.md`)
- **Diff scope (audit only):** (file list or `git diff <base>..<head>`)

## Page kind → impeccable mode mapping

When impeccable is installed, map `page_kind` to one of impeccable's four modes.
The mode comes from the surface, not from what the company sells.

| `page_kind` | Impeccable mode | What it means |
|---|---|---|
| landing / marketing / pricing / campaign | Persuade | The visitor decides and acts. Design earns attention. |
| app_screen / dashboard / editor / admin / tool | Operate | The visitor completes a task. Density, predictable controls. |
| docs / guide / help / changelog | Read | The visitor understands something. Comprehension first. |
| portfolio / gallery / showcase | Experience | The visitor is inside the work. The artifact leads. |

Pass this mode to impeccable commands when invoking them.

## Direction contract (output, when impeccable is installed)

After intake, state the direction as a 5-block contract (at most 150 words
total), written as a comment at the top of the artifact:

- **THESIS**: the one idea this page owns, and the category default it refuses.
- **OWN-WORLD**: the palette and component language, specific enough to recognize with all content removed.
- **STORY**: what the visitor understands, believes, and does.
- **FIRST VIEWPORT**: the exact composition and where the primary action sits.
- **FORM**: the chosen form and the seed key (for reproducible re-rolls).

The finishing review (phase 3) audits the built page against this contract,
promise by promise.

## Design Read (output, fallback when impeccable is NOT installed)

If impeccable is not installed, state in one line:

> Reading this as: \<page kind> for \<audience>, with a \<vibe> language, leaning
> toward \<design system or aesthetic family>.

If the brief is ambiguous, ask **one** clarifying question. If you can infer
confidently, declare the read and proceed.

## Anti-default discipline

Do not default to: AI-purple gradients, centered hero over dark mesh, three
equal feature cards, generic glassmorphism, infinite-loop micro-animations,
Inter + slate-900. These are LLM defaults — reach past them deliberately based
on the design read.

If impeccable is installed, its new-work flow breaks this defaulting
mechanically: a roll decides which of the model's own ideas has to be taken
seriously, and deals challengers from a reviewed catalog of 188 visual worlds.
Use it when the brief is open-ended.
