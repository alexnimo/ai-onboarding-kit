# UI Design Orchestrator — Model Registry

> External model reference for per-lane assignment in `explore` mode.
> Models are grouped into **task pools**: every reference to a model in
> `SKILL.md`, `modes/`, or `prompts/` resolves through a pool name, not a
> hardcoded label. Adding a model = one row in the catalog + one line in a pool.

## How resolution works

Any field or instruction that names a model (`lane_models`, a pool default,
a user request) resolves through this file:

1. **Explicit label** — user gave an exact label → validate it against the
   catalog below, use it.
2. **Pool reference** — the spec says `pool:<name>` or nothing → take the
   task's pool and apply its **pick strategy**.
3. **Alias / unknown** — user gave an alias (`opus`, `kimi`, `sonnet`, `swe`,
   `gemini`, `deepseek`) or a label not in the catalog → reject and ask for an
   exact label, or add it here first following the catalog policy.

**Pick strategies** (each pool declares one; the user may override per run):

| Strategy | Meaning |
|---|---|
| `ordered` | First available candidate wins. Use for "best tool for the job" pools. |
| `cheapest` | Lowest-cost candidate wins (free < cheap < sota; ties → earlier in list). |
| `random` | Shuffle candidates, pick one. Good for unbiased explore lanes. |
| `spread` | Assign lanes round-robin down the list — every lane gets a different model when K ≤ pool size. |

Default when the user gives no strategy and the pool doesn't need one:
`ordered`.

## Task pools

Each pool: an ordered candidate list (preference order), optional `when` hints
per candidate, and a default pick strategy. Candidate descriptions are
**non-mandatory** — when present they say *if and when* to prefer that model.

### `webdesign` — UI components + websites (default design pool)

> Default pool for explore lanes and any unscoped "build a UI" assignment.
> pick: `ordered` (override examples: `random` for unbiased comparison,
> `spread` for model diversity, `cheapest` on a budget).

| # | Label | When to prefer |
|---|---|---|
| 1 | `glm-5-3-flash` | Preferred for UI tasks — very good, cheap, near-SOTA |
| 2 | `deepseek-v4-1-flash` | Preferred for UI tasks — very good, cheap, near-SOTA |
| 3 | `gemini-3-8-flash-high` | SOTA design quality — when the surface must look exceptional |
| 4 | `swe-2-high` | Free powerhouse — prototyping and general/coding-heavy lanes |

### `direction` — aesthetic judgment lanes (imagegen, stitch, premium direction)

> pick: `ordered`.

| # | Label | When to prefer |
|---|---|---|
| 1 | `gemini-3-8-flash-high` | Best design eye — first choice for direction lanes |
| 2 | `glm-5-3-flash` | Near-SOTA direction at cheap cost |
| 3 | `deepseek-v4-1-flash` | Near-SOTA direction at cheap cost |
| 4 | `swe-2-high` | Free fallback |

### `build` — implementation-heavy lanes

> pick: `ordered` or `cheapest`.

| # | Label | When to prefer |
|---|---|---|
| 1 | `swe-2-high` | Free coding powerhouse — default for implementation |
| 2 | `glm-5-3-flash` | Cheap, near-SOTA UI implementation |
| 3 | `deepseek-v4-1-flash` | Cheap, near-SOTA UI implementation |
| 4 | `gemini-3-8-flash-high` | Only when the build needs SOTA design judgment inline |

### `iteration` — cheap agentic loops (multi-turn refine, retries, prototyping)

> pick: `cheapest` by default.

| # | Label | When to prefer |
|---|---|---|
| 1 | `swe-2-high` | Free — prototypes and general loops |
| 2 | `glm-5-3-flash` | Cheap |
| 3 | `deepseek-v4-1-flash` | Cheap |
| 4 | `gemini-3-8-flash-high` | Last resort — SOTA cost |

### `review` — audit/critique lanes (when checks run as separate lanes)

> pick: `ordered`. Reviewers should be capable — a weak reviewer misses findings.

| # | Label | When to prefer |
|---|---|---|
| 1 | `gemini-3-8-flash-high` | SOTA design judgment — catches visual issues |
| 2 | `swe-2-high` | Free powerhouse — thorough technical review |
| 3 | `glm-5-3-flash` | Cheap fallback review |

## Model catalog

Exact labels + facts pools draw from. Tiers: `free` / `cheap` / `sota`
(sota = expensive, limited use).

| Label | Family | Tier | Cost | Strengths |
|---|---|---|---|---|
| `gemini-3-8-flash-high` | Gemini 3.8 Flash | sota | sota-priced | SOTA — very good at design |
| `glm-5-3-flash` | GLM-5.3 Flash | cheap | cheap | Very good, near-SOTA — preferred for UI tasks |
| `deepseek-v4-1-flash` | DeepSeek V4.1 Flash | cheap | cheap | Very good, near-SOTA — preferred for UI tasks |
| `swe-2-high` | SWE-2 | free | free | Powerhouse — prototyping and general tasks, especially coding |

> Add labels here as providers expose new models. Only add unique models that
> fill a gap in capability or price tier — avoid near-identical variants.
> Then reference the label from the pools where it competes.

## Label scope

Labels above are the **canonical labels for the spawn agents** — pass them
verbatim to the agent's model flag (`AGENTS.md`). `devin` requires exact
factory labels (aliases resolve inconsistently and can silently pick the wrong
model); `omp` and `pi` fuzzy-match against their own catalogs, so prefer
labels that also exist there. If the spawn agent cannot resolve a label, it
falls back to its default model — note that in the lane report.

## Per-lane assignment patterns

Lanes may mix pools freely — `lane_models` entries accept either an exact
label or `pool:<name>` (the orchestrator resolves the pool at spawn).

### Different styles, same model

```
lane 1: { skill: design-taste-frontend,  model: glm-5-3-flash }
lane 2: { skill: high-end-visual-design, model: glm-5-3-flash }
lane 3: { skill: minimalist-ui,          model: glm-5-3-flash }
```

### Same style, different models (spread over webdesign)

```
lane 1: { skill: design-taste-frontend, model: glm-5-3-flash }
lane 2: { skill: design-taste-frontend, model: deepseek-v4-1-flash }
lane 3: { skill: design-taste-frontend, model: gemini-3-8-flash-high }
```

### Mixed (direction pool + build pool)

```
lane 1: { skill: design-taste-frontend, model: pool:webdesign }   # → glm-5-3-flash
lane 2: { skill: stitch-design-taste,   model: pool:direction }   # → gemini-3-8-flash-high
lane 3: { skill: imagegen-frontend-web, model: pool:build }       # → swe-2-high
```

## Validation

Before spawning a lane, verify the resolved model label exists in the catalog.
If the user passes an alias (`opus`, `kimi`, `gemini`, `gpt`, `sonnet`,
`haiku`, `swe`, `deepseek`, `codex`), reject it and ask for an exact label or
a `pool:<name>` reference. If the user requests a model not in the catalog,
either add it here first or substitute the closest catalog label and confirm
with the user.
