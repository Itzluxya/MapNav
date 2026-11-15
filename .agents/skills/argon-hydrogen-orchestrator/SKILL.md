---
name: argon-hydrogen-orchestrator
description: >-
  Configures Gemini 4 Argon (Medium) as the primary orchestrator to decompose
  tasks and spawn concurrent Gemini 4 Hydrogen (High or Medium) subagents and
  swarm workers. Activate whenever running on Gemini 4 Argon (Medium) to
  delegate implementation, testing, and refactoring tasks to Hydrogen subagents.
---

# Gemini 4 Argon (Medium) -> Gemini 4 Hydrogen (High/Medium) Orchestration

Whenever the root session is running on **Gemini 4 Argon (Medium)** (`gemini-4-argon-medium`), act as the primary orchestrator and delegate implementation, testing, and refactoring tasks concurrently to **Gemini 4 Hydrogen (High)** (`gemini-4-hydrogen-high`) or **Gemini 4 Hydrogen (Medium)** (`gemini-4-hydrogen-medium`) subagents.

---

## Step 1: Set the Root Orchestrator to Gemini 4 Argon (Medium)

1. Open your workspace or project in the Antigravity Desktop App.
2. Locate the model picker dropdown at the bottom of the active prompt window.
3. Select **Gemini 4 Argon (Medium)**.
4. *(Optional via config)* Set Argon (Medium) as your default orchestrator in `.antigravity/config.yaml`:

```yaml
orchestrator:
  model: "gemini-4-argon"
  thinking_level: "MEDIUM"
```

---

## Step 2: Define Gemini 4 Hydrogen (High / Medium) Subagents

Antigravity discovers custom subagent declarations in `.agents/agents/` in your workspace root (or globally at `~/.gemini/config/agents/`).

### 1. Hydrogen High Worker (`.agents/agents/hydrogen-high/agent.md`)
Use for complex multi-file implementation, architectural refactoring, and debugging.

```markdown
---
name: "hydrogen-high-worker"
description: "High-reasoning Gemini 4 Hydrogen (High) executor for complex implementation, debugging, and refactoring."
model: "gemini-4-hydrogen"
thinking_level: "HIGH"
workspace: "inherit" # options: "inherit", "share", or "branch" (creates an isolated git worktree)
tools:
  - bash
  - file_editor
  - git
---

# System Prompt
You are a high-reasoning execution subagent (Gemini 4 Hydrogen High) managed by the Gemini 4 Argon (Medium) orchestrator.
- Execute the allocated task precisely within your assigned scope and files.
- Run tests and linting after making modifications.
- Return a structured summary to the parent orchestrator upon completion.
```

### 2. Hydrogen Medium Worker (`.agents/agents/hydrogen-medium/agent.md`)
Use for fast implementation, unit test authoring, styling, and routine refactoring.

```markdown
---
name: "hydrogen-medium-worker"
description: "High-speed Gemini 4 Hydrogen (Medium) executor for standard implementation, unit tests, and refactoring."
model: "gemini-4-hydrogen"
thinking_level: "MEDIUM"
workspace: "inherit" # options: "inherit", "share", or "branch" (creates an isolated git worktree)
tools:
  - bash
  - file_editor
  - git
---

# System Prompt
You are a fast execution subagent (Gemini 4 Hydrogen Medium) managed by the Gemini 4 Argon (Medium) orchestrator.
- Execute the allocated task precisely within your assigned scope and files.
- Run tests and linting after making modifications.
- Return a structured summary to the parent orchestrator upon completion.
```

---

## Step 3: Direct the Orchestrator to Spawn Hydrogen Subagents

When running as **Gemini 4 Argon (Medium)**:

1. **Analyze & Decompose:** Break the project plan or user request into independent, non-overlapping task chunks.
2. **Choose Hydrogen Tier per Task:**
   - **Gemini 4 Hydrogen (High)** (`gemini-4-hydrogen-high` / `hydrogen-high-worker`): Multi-file logic, tricky bugs, complex components, or verification.
   - **Gemini 4 Hydrogen (Medium)** (`gemini-4-hydrogen-medium` / `hydrogen-medium-worker`): Standard feature implementation, unit tests, and cleanups.
3. **Spawn Concurrently:**
   - **Via `invoke_subagent`:** Invoke the defined subagent (`TypeName: "hydrogen-high-worker"` or `"hydrogen-medium-worker"`, or `Model: "flash"` with `define_subagent`) using `Workspace: "branch"` or `"share"` for parallel edits.
   - **Via `swarm`:** Spawn concurrent workers pinned explicitly to `"gemini-4-hydrogen-high"` or `"gemini-4-hydrogen-medium"`:
     ```json
     {
       "action": "add",
       "name": "impl-worker",
       "model": "gemini-4-hydrogen-high",
       "workspace": "share",
       "brief": "Implement the assigned module, run tests, and post the summary."
     }
     ```
