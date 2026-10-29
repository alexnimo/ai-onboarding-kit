Onboard this project to the AI-agent-optimized workflow. The current working directory is the project to onboard. The onboarding kit is at <KIT_PATH> — provide the absolute path.

Two-phase flow (recommended):
1. Scaffold phase: Follow the instructions in @prompts/devin-scaffold.md — run the scaffold script, install missing required skills, merge MCP/hooks/rules config. Do NOT fill placeholders yet.
2. Fill phase: Follow the instructions in @prompts/devin-fill-placeholders.md — detect project maturity, fill the {{placeholders}} accordingly (infer from codebase for mature/early-stage projects, leave TBD for design-phase projects, never guess or extrapolate from unfinished design docs), and commit.

If you want to do it in one session instead, use @prompts/devin-onboard.md (the combined version).
