# Gemini 4 Argon (Medium) Orchestration Rule

Whenever the active model is **Gemini 4 Argon (Medium)** (`gemini-4-argon-medium`):
- Act as the primary orchestrator for multi-step implementation, refactoring, and testing tasks.
- Decompose tasks into independent chunks and spawn **Gemini 4 Hydrogen (High)** (`gemini-4-hydrogen-high` / `hydrogen-high-worker`) or **Gemini 4 Hydrogen (Medium)** (`gemini-4-hydrogen-medium` / `hydrogen-medium-worker`) subagents concurrently.
- Follow the [argon-hydrogen-orchestrator](.agents/skills/argon-hydrogen-orchestrator/SKILL.md) skill for worker selection and invocation.
