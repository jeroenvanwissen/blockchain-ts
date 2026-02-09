# Project Analysis Instructions

> Reusable instructions for an AI agent to analyze any project and generate a structured task backlog.
> Copy this file into a project's `.agent/` folder, then instruct the agent to follow it.

---

## Overview

This document instructs you to:

1. **Analyze** the project — read every source file, configuration, test, and documentation
2. **Identify** bugs, security issues, missing features, dead code, and improvements
3. **Extract** project conventions — code style, testing patterns, security practices, architecture decisions
4. **Generate** a structured `.agent/` folder with a task index, per-task detail files, and a workflow guide
5. **Generate** a `.claude/` folder with project instructions and convention rules

**Output structure:**

```
.agent/
├── ANALYZE.md                      # This file (instructions — keep for future re-analysis)
├── TASKS.md                        # Task index with priority-ordered waves
├── README.md                       # Agent workflow guide
└── tasks/
    ├── A1-short-slug.md            # Individual task files
    ├── A2-short-slug.md
    ├── B1-short-slug.md
    └── ...

.claude/
├── CLAUDE.md                       # Main project instructions (loaded into agent context)
└── rules/
    ├── project.md                  # Project structure and architecture guidelines
    ├── code-style.md               # Code style and formatting conventions
    ├── testing.md                  # Testing conventions and requirements
    └── security.md                 # Security requirements and practices
```

---

## Phase 1: Deep Analysis

Read and understand the entire project before generating any output.

### 1.1 — Read Everything

- [ ] All source files (every directory, every file)
- [ ] Configuration files (build configs, linters, formatters, CI/CD)
- [ ] Package/dependency manifests
- [ ] Existing documentation (README, docs/, wikis, comments)
- [ ] Existing TODO/FIXME/HACK comments in source code
- [ ] Test files and test configuration
- [ ] Environment and deployment configuration
- [ ] Data files, schemas, migrations

### 1.2 — Map the Architecture

Document your understanding of:

- **Project purpose** — What does this project do?
- **Entry points** — Where does execution start?
- **Core components** — What are the main modules/classes/services?
- **Data flow** — How does data move through the system?
- **External dependencies** — What libraries/services does it rely on?
- **Build and run process** — How is the project built, tested, and run?
- **Test infrastructure** — What testing exists and what's the coverage?

### 1.3 — Extract Conventions

While reading the codebase, extract the following conventions and patterns. These will be used to generate the `.claude/` rules files.

#### Code Style

- Naming patterns (files, classes, functions, variables, constants)
- Formatting style (indentation, line length, bracket placement)
- Import organization (ordering, grouping, path aliases)
- Comment style and documentation patterns
- Error handling patterns (how errors are thrown, caught, propagated)
- Logging patterns (what logger is used, log levels, message format)

#### Architecture

- Directory structure and module organization
- Design patterns in use (MVC, service layer, repository, etc.)
- State management approach
- Configuration management (env vars, config files, constants)
- Dependency injection or initialization patterns

#### Testing

- Test framework and runner
- Test file location and naming convention
- Test structure (describe/it, arrange-act-assert, given-when-then)
- Mocking and fixture patterns
- What is tested vs. what is not
- Coverage requirements (if any)

#### Security

- Authentication and authorization patterns
- Input validation approach
- Secret management (how keys, tokens, credentials are handled)
- Data sanitization patterns
- Encryption usage

#### Dependencies

- Package manager and lockfile
- Version pinning strategy (exact, caret, tilde)
- Internal vs. external dependency boundaries

### 1.4 — Identify Findings

Systematically look for issues in these categories:

#### Critical — Security & Correctness

- Security vulnerabilities (injection, auth bypass, data exposure, crypto misuse)
- Data corruption or loss scenarios
- Race conditions on shared mutable state
- Broken core functionality (features that don't work as intended)
- Consensus or consistency violations (for distributed systems)

#### High — Validation & Reliability

- Missing input validation
- Missing error handling (empty catch blocks, unhandled promises/exceptions)
- Incorrect or incomplete business logic
- Missing boundary checks
- Inconsistent state management

#### Medium — Features & Improvements

- Missing features that are expected or documented but not implemented
- Hardcoded values that should be configurable
- Performance bottlenecks
- Poor test coverage
- Tight coupling between components
- Test bypasses or environment-specific hacks in production code

#### Low — Cleanup & Polish

- Dead code (unused functions, variables, imports, config values)
- Inconsistent naming or formatting
- Missing or scattered logging
- Documentation gaps
- Dependency updates

---

## Phase 2: Prioritize and Group

### 2.1 — Assign Priority

Every finding gets a priority:

| Priority     | Criteria                                                              |
| ------------ | --------------------------------------------------------------------- |
| **Critical** | System is broken, insecure, or produces incorrect results without fix |
| **High**     | Significant gap in validation, reliability, or core feature           |
| **Medium**   | Missing feature, improvement, or moderate risk                        |
| **Low**      | Cleanup, polish, nice-to-have                                         |

### 2.2 — Group into Waves

Organize findings into **priority-ordered waves** labeled A through F (or beyond if needed):

| Wave | Purpose                         | Start Condition                 |
| ---- | ------------------------------- | ------------------------------- |
| A    | Critical fixes                  | Immediately, all independent    |
| B    | Core validation and reliability | After relevant A tasks complete |
| C    | Hardening and robustness        | After relevant B tasks complete |
| D    | Infrastructure and integration  | After core is solid             |
| E    | Features and improvements       | After infrastructure is ready   |
| F    | Cleanup and nice-to-have        | Anytime, lowest priority        |

**Rules:**

- Wave A tasks should have **no dependencies** on each other (can all start in parallel)
- Each subsequent wave unlocks after its dependencies in previous waves are met
- Tasks within a wave may depend on each other — that's fine
- Independent tasks (no dependencies) can be placed in earlier waves even if lower priority
- A task's wave is determined by its **earliest possible start**, not just its priority

### 2.3 — Map Dependencies

For each task, identify:

- Which other tasks must complete first (prerequisites)
- Which tasks this enables (dependents)

Dependencies should reference task IDs (e.g., `A1`, `B3`), not wave labels.

### 2.4 — Assign IDs

Within each wave, number tasks sequentially:

- Wave A: `A1`, `A2`, `A3`, `A4`
- Wave B: `B1`, `B2`, `B3`, `B4`
- etc.

Order within a wave: higher priority and fewer dependencies first.

---

## Phase 3: Generate Output

### 3.1 — Generate Per-Task Files

Create one file per task in `.agent/tasks/`.

**File naming:** `<ID>-<short-slug>.md` (e.g., `A1-fix-auth-bypass.md`, `B3-add-input-validation.md`)

**Slug rules:**

- Lowercase, hyphen-separated
- 2-4 words describing the task
- No language or framework names in the slug

**Template:**

````markdown
# Task {{ID}}: {{Title}}

| Field            | Value                              |
| ---------------- | ---------------------------------- |
| **ID**           | `{{ID}}`                           |
| **Status**       | `[ ]`                              |
| **Priority**     | {{Critical / High / Medium / Low}} |
| **Dependencies** | {{Comma-separated IDs, or "None"}} |
| **Branch**       | `{{prefix}}/{{id-slug}}`           |

**Goal:**
{{1-3 sentences explaining what this task achieves and why it matters.}}

**Current Problem:**

{{Optional. Include only for bug fixes. Show the problematic code or describe the incorrect behavior. Use a fenced code block if showing code.}}

**Scope:**

```
{{project-relative path}}/
├── file-to-create                  # CREATE — brief description
├── file-to-modify                  # MODIFY — what changes
├── file-to-delete                  # DELETE — why removing
└── file-to-verify                  # VERIFY — check consistency
```

**Implementation:**

1. {{Specific, actionable step}}
2. {{Specific, actionable step}}
3. {{Specific, actionable step}}

**Acceptance Criteria:**

- [ ] {{Observable, testable criterion}}
- [ ] {{Observable, testable criterion}}
- [ ] {{Observable, testable criterion}}
- [ ] Build passes: `{{project build command}}`
- [ ] Tests pass: `{{project test command}}`

**Verification Commands:**

```bash
{{project build command}}
{{project test command}}
{{any additional verification steps}}
```
````

**Branch prefix conventions:**

| Task Type       | Prefix      | Example                       |
| --------------- | ----------- | ----------------------------- |
| Bug fix         | `fix/`      | `fix/a1-auth-bypass`          |
| New feature     | `feature/`  | `feature/d1-rest-api`         |
| Refactor        | `refactor/` | `refactor/c3-extract-service` |
| Test            | `test/`     | `test/e6-coverage`            |
| Chore / cleanup | `chore/`    | `chore/f2-logging`            |

**Writing guidelines:**

- **Goal** — Focus on the "why" and the outcome, not implementation details
- **Current Problem** — Only include for fixes. Show the actual broken code or behavior
- **Scope** — List every file that will be touched. Use a tree structure with action annotations
- **Implementation** — Numbered steps an agent can follow without interpretation. Be specific about what to do in each file
- **Acceptance Criteria** — Must be verifiable without subjective judgment. Always include "build passes" and "tests pass" as final criteria
- **Verification Commands** — Copy-pasteable commands. Include comments for manual verification steps

### 3.2 — Generate TASKS.md

Create `.agent/TASKS.md` as the central task index.

**Template:**

````markdown
# Project Tasks

> {{One-line project description}}.
> Each task = 1 PR with clear acceptance criteria.

---

## Task Status Legend

| Status | Meaning                    |
| ------ | -------------------------- |
| `[ ]`  | not-started                |
| `[~]`  | in-progress                |
| `[x]`  | completed                  |
| `[!]`  | blocked (needs discussion) |

---

## Current Tasks

### Wave A — {{Wave Title}}

_{{One-line description of what this wave addresses.}}_

| Status | ID   | Task                                 | Priority | Dependencies |
| ------ | ---- | ------------------------------------ | -------- | ------------ |
| `[ ]`  | `A1` | [Task Title](tasks/A1-short-slug.md) | Critical | None         |
| `[ ]`  | `A2` | [Task Title](tasks/A2-short-slug.md) | Critical | None         |

### Wave B — {{Wave Title}}

_{{One-line description.}}_

| Status | ID   | Task                                 | Priority | Dependencies |
| ------ | ---- | ------------------------------------ | -------- | ------------ |
| `[ ]`  | `B1` | [Task Title](tasks/B1-short-slug.md) | High     | A1           |

{{Continue for all waves...}}

---

## Dependency Graph

```
Wave A (all independent — start in parallel):
A1, A2, A3

Wave B (depends on Wave A):
A1 ──> B1
A2 ──> B2

{{Continue for all waves...}}
```

---

## Verification Commands Reference

```bash
{{project build command}}
{{project test command}}
{{project lint command}}
{{other common commands}}
```

---

## Guardrails

| Rule                           | Value               | Action                |
| ------------------------------ | ------------------- | --------------------- |
| Max files changed per PR       | 8                   | Split into subtasks   |
| Max diff lines (added+removed) | 500                 | Split into subtasks   |
| Compile check                  | `{{build command}}` | Must pass before PR   |
| Test suite                     | `{{test command}}`  | Must pass before PR   |
| Code review required           | All PRs             | Required before merge |
| Ambiguity detected             | Missing info        | **STOP and ask user** |

---

## Notes

- **Start with Wave A** — these are independent and can all be worked on in parallel
- Each wave unlocks the next; don't skip ahead unless dependencies are met
- Update status as work progresses (`[ ]` → `[~]` → `[x]`)
- Each task should be completed on its own feature branch and merged via PR
````

### 3.3 — Generate README.md

Create `.agent/README.md` as the agent workflow guide.

**Template:**

````markdown
# Agent Environment

> Guide for executing development tasks on {{project-name}}.

---

## Contents

| File                 | Purpose                        |
| -------------------- | ------------------------------ |
| [TASKS.md](TASKS.md) | Task index and project backlog |
| [tasks/](tasks/)     | Individual task detail files   |

---

## Quick Start

```
1. Open .agent/TASKS.md
2. Pick a task and create a branch:  git checkout -b <prefix>/<task-id>-<name>
3. Execute the task following its implementation steps
4. Run verification:                 {{build and test commands}}
5. Commit:                           git add -A && git commit -m "descriptive message"
6. Push:                             git push -u origin <branch-name>
7. Create PR:                        gh pr create --title "..." --body "..."
8. Mark task as completed in TASKS.md
```

---

## Workflow

### Step 1: Create Branch

```bash
git checkout main
git pull origin main
git checkout -b <prefix>/<task-id>-<short-name>
```

### Step 2: Open Task File

Open the task file from `.agent/tasks/` and follow its implementation steps.

### Step 3: Implement

Follow the **Implementation** steps and **Scope** (files to create/modify) from the task file.

### Step 4: Verify

Run the verification commands listed in the task file.

### Step 5: Check Guardrails

```bash
git diff --stat | tail -1  # Check diff size
# Max 8 files, max 500 lines changed
```

### Step 6: Commit

Use this commit message format:

```
<type>(<scope>): <subject>

Task <ID> from .agent/TASKS.md
- Bullet point summary of changes
```

**Commit types:** `feat`, `fix`, `refactor`, `test`, `chore`

### Step 7: Push and Create PR

```bash
git push -u origin <branch-name>

gh pr create \
  --title "<type>(<scope>): brief description" \
  --body "Completes task <ID> from .agent/TASKS.md

## Changes
- List of changes made

## Verification
- [x] Build passes
- [x] Tests pass
- [x] All acceptance criteria met"
```

### Step 8: Update Task Status

After PR is merged, update the task status in TASKS.md (`[ ]` → `[x]`).

---

## Guardrails

| Rule                           | Value        | Action                |
| ------------------------------ | ------------ | --------------------- |
| Max files changed per PR       | 8            | Split into subtasks   |
| Max diff lines (added+removed) | 500          | Split into subtasks   |
| Build check                    | Must pass    | Required before PR    |
| Test suite                     | Must pass    | Required before PR    |
| Code review required           | All PRs      | Required before merge |
| Ambiguity detected             | Missing info | **STOP and ask user** |
````

### 3.4 — Generate .claude/CLAUDE.md

Create `.claude/CLAUDE.md` as the main project instructions file. This file is loaded into the agent's context at the start of every conversation and should contain the essential information needed to work on the project.

**Keep CLAUDE.md concise** — it's loaded every time, so avoid bloat. Link to rules files for details.

**Template:**

````markdown
# {{project-name}}

> {{One-line project description.}}

## Quick Reference

| Action   | Command             |
| -------- | ------------------- |
| Build    | `{{build command}}` |
| Test     | `{{test command}}`  |
| Lint     | `{{lint command}}`  |
| Run      | `{{run command}}`   |
| Dev mode | `{{dev command}}`   |

## Project Structure

```
{{top-level directory tree showing key folders and their purpose}}
```

## Architecture

{{2-5 sentences describing the core architecture: what the system does, its main components, and how they interact.}}

## Key Decisions

{{Bullet list of important architectural decisions and their reasoning. Include anything a developer must know to avoid making incorrect assumptions.}}

- {{Decision 1 — rationale}}
- {{Decision 2 — rationale}}
- {{Decision 3 — rationale}}

## Rules

Detailed conventions are in `.claude/rules/`:

| File                                       | Covers                               |
| ------------------------------------------ | ------------------------------------ |
| [rules/project.md](rules/project.md)       | Project structure and architecture   |
| [rules/code-style.md](rules/code-style.md) | Code style and formatting            |
| [rules/testing.md](rules/testing.md)       | Testing conventions and requirements |
| [rules/security.md](rules/security.md)     | Security requirements and practices  |

## Documentation Maintenance

When making changes to the codebase, update all affected documentation files to stay in sync:

| File                                       | Update when...                                     |
| ------------------------------------------ | -------------------------------------------------- |
| [README.md](../README.md)                  | Features, architecture, config, or usage changes   |
| [.agent/TASKS.md](../.agent/TASKS.md)      | Task status changes (started, completed, blocked)  |
| [.agent/README.md](../.agent/README.md)    | Workflow or tooling changes                        |
| [.claude/CLAUDE.md](./)                    | Architecture, key decisions, or structure changes  |
| [rules/code-style.md](rules/code-style.md) | New patterns, naming conventions, or style changes |
| [rules/project.md](rules/project.md)       | New files, directories, or dependency changes      |
| [rules/security.md](rules/security.md)     | Security-relevant changes or new validations       |
| [rules/testing.md](rules/testing.md)       | New test files, patterns, or framework changes     |

## Tasks

See [.agent/TASKS.md](../.agent/TASKS.md) for the project backlog and task details.
````

### 3.5 — Generate .claude/rules/

Create rule files in `.claude/rules/` based on conventions extracted in Phase 1.3. Each file covers a specific domain and should be **prescriptive** — tell the agent what to do, not just describe what exists.

**Writing guidelines for rules:**

- Use imperative voice ("Use X", "Always Y", "Never Z")
- Include concrete examples (do/don't pairs)
- Keep rules observable and enforceable — avoid subjective guidelines
- Only include rules that are actually followed in the codebase (don't invent new conventions)
- If the project has no clear convention for something, note it as "No established convention" rather than making one up

---

#### rules/project.md

Project structure, architecture guidelines, and module organization.

**Template:**

````markdown
# Project Guidelines

## Directory Structure

```
{{annotated directory tree showing what goes where}}
```

## Module Organization

- {{Rule about where new files should be placed}}
- {{Rule about module boundaries and imports}}
- {{Rule about shared vs. local code}}

## Naming Conventions

### Files

- {{Pattern for source files}}
- {{Pattern for test files}}
- {{Pattern for config files}}

### Directories

- {{Pattern for module directories}}
- {{Pattern for test directories}}

## Configuration

- {{Where configuration values live}}
- {{How to add new configuration}}
- {{Environment variable conventions}}

## Dependencies

- {{How to add new dependencies}}
- {{Version pinning strategy}}
- {{Internal vs. external dependency rules}}
````

---

#### rules/code-style.md

Code formatting, naming, and structural patterns.

**Template:**

```markdown
# Code Style

## Formatting

- {{Indentation style and size}}
- {{Line length limit}}
- {{Bracket/brace placement}}
- {{Trailing comma convention}}
- {{Semicolon convention}}
- {{Quote style}}

## Naming

### Variables and Functions

- {{Casing convention and examples}}
- {{Prefix/suffix patterns}}
- {{Boolean naming (isX, hasX, canX)}}

### Types / Classes / Interfaces

- {{Casing convention and examples}}
- {{Prefix/suffix patterns}}

### Constants

- {{Casing convention and examples}}
- {{Where constants are defined}}

## Imports

- {{Import ordering rules}}
- {{Path alias usage}}
- {{Default vs. named exports}}

## Patterns

### Error Handling

- {{How errors are created and thrown}}
- {{How errors are caught and handled}}
- {{Error propagation pattern}}

### Logging

- {{Logger used}}
- {{Log level conventions}}
- {{What to log and what not to log}}

### Async

- {{Async/await vs. callbacks vs. promises}}
- {{Concurrency patterns}}

## Do / Don't

| Do                       | Don't                   |
| ------------------------ | ----------------------- |
| {{Good pattern example}} | {{Bad pattern example}} |
| {{Good pattern example}} | {{Bad pattern example}} |
```

---

#### rules/testing.md

Testing conventions, patterns, and requirements.

**Template:**

````markdown
# Testing Conventions

## Framework

- **Test runner:** {{name}}
- **Assertion library:** {{name}}
- **Mocking:** {{approach}}

## File Organization

- Test location: {{alongside source / separate directory / pattern}}
- Test file naming: {{pattern, e.g., `*.test.ext`, `*.spec.ext`}}
- Test helper location: {{where shared test utilities live}}

## Test Structure

```
{{example test structure using the project's actual pattern}}
```

## Naming

- Test suites: {{describe block naming convention}}
- Test cases: {{it/test block naming convention — e.g., "should verb when condition"}}

## Patterns

### Setup and Teardown

- {{How test fixtures are created}}
- {{How cleanup is handled}}
- {{Shared vs. per-test setup}}

### Mocking

- {{What to mock (external services, I/O, time)}}
- {{What NOT to mock (business logic, pure functions)}}
- {{Mocking pattern examples}}

### Assertions

- {{Assertion style preferences}}
- {{How many assertions per test}}

## Coverage

- **Minimum coverage:** {{percentage or "not enforced"}}
- **Coverage command:** `{{coverage command}}`
- **Excluded from coverage:** {{patterns or directories}}

## Do / Don't

| Do                       | Don't                   |
| ------------------------ | ----------------------- |
| {{Good testing pattern}} | {{Bad testing pattern}} |
| {{Good testing pattern}} | {{Bad testing pattern}} |
````

---

#### rules/security.md

Security requirements and practices.

**Template:**

```markdown
# Security Requirements

## Secrets Management

- {{How secrets are stored (env vars, vault, config)}}
- {{How secrets are accessed in code}}
- {{What must never be committed (patterns, file types)}}

## Input Validation

- {{Where validation happens (boundary, every layer, etc.)}}
- {{Validation approach (schema, manual, library)}}
- {{Sanitization requirements}}

## Authentication & Authorization

- {{Auth mechanism used}}
- {{How auth state is managed}}
- {{Authorization check patterns}}

## Data Protection

- {{Encryption at rest requirements}}
- {{Encryption in transit requirements}}
- {{Sensitive data handling (PII, credentials, keys)}}
- {{Data that must never be logged}}

## Dependencies

- {{How dependency vulnerabilities are checked}}
- {{Update policy for security patches}}

## Do / Don't

| Do                        | Don't                    |
| ------------------------- | ------------------------ |
| {{Good security pattern}} | {{Bad security pattern}} |
| {{Good security pattern}} | {{Bad security pattern}} |
```

---

#### Additional Rules (optional)

If the project has other significant conventions, create additional rule files:

- `rules/api.md` — API design conventions (REST, GraphQL, RPC patterns)
- `rules/database.md` — Database conventions (queries, migrations, naming)
- `rules/deployment.md` — Deployment and CI/CD conventions
- `rules/git.md` — Git workflow conventions (branching, commit messages, PR process)

Only create additional rule files if the project has established conventions for that domain. Don't generate empty or speculative rules.

---

## Phase 4: Quality Checklist

Before presenting the output, verify:

### Task Files

- [ ] Every finding from the analysis is captured in a task
- [ ] Every task has all template sections filled in (no empty sections)
- [ ] Every task has at least 2 acceptance criteria beyond "build/tests pass"
- [ ] Implementation steps are specific and actionable (no vague steps like "improve X")
- [ ] Scope tree lists every file that will be touched
- [ ] No two tasks modify the same file in conflicting ways without a dependency link
- [ ] Dependencies reference valid task IDs that exist
- [ ] No circular dependencies

### TASKS.md

- [ ] All task files are linked in the wave tables
- [ ] Wave A tasks have no dependencies (all can start in parallel)
- [ ] Dependency graph is consistent with the dependency fields in task files
- [ ] Every task ID in the dependency graph matches an existing task
- [ ] Priorities are consistent (Critical tasks in earlier waves)

### Naming

- [ ] IDs are sequential within each wave (A1, A2, A3... not A1, A3)
- [ ] File slugs are lowercase, hyphen-separated, 2-4 words
- [ ] Branch names follow the prefix convention (fix/, feature/, etc.)
- [ ] No duplicate task IDs

### Content

- [ ] No references to specific programming languages in ANALYZE.md itself
- [ ] Task files may reference project-specific languages and tools (that's expected)
- [ ] No subjective or vague acceptance criteria ("code is cleaner" — bad)
- [ ] Verification commands are copy-pasteable

### CLAUDE.md

- [ ] Quick reference table has correct, working commands
- [ ] Project structure tree matches actual directory layout
- [ ] Architecture section is accurate and concise (not a wall of text)
- [ ] Key decisions are genuinely important (not trivia)
- [ ] Rules table links to existing rule files

### Rules Files

- [ ] Every rule is based on actual project conventions (not invented)
- [ ] Rules use imperative voice ("Use X", not "X is used")
- [ ] Rules include concrete examples where helpful
- [ ] No contradictions between rule files
- [ ] No rules about conventions the project doesn't have (mark as "No established convention" instead)
- [ ] Do/Don't tables have real examples from the codebase
- [ ] Security rules cover actual risks identified in Phase 1

---

## Execution Checklist

Use this checklist when running the analysis:

```
[ ] Phase 1: Read all source files, configs, tests, docs
[ ] Phase 1: Map the architecture
[ ] Phase 1: Extract conventions (code style, testing, security, architecture)
[ ] Phase 1: Identify all findings (bugs, security, features, cleanup)
[ ] Phase 2: Assign priority to each finding
[ ] Phase 2: Group into waves (A = most critical)
[ ] Phase 2: Map dependencies between tasks
[ ] Phase 2: Assign sequential IDs within each wave
[ ] Phase 3: Generate per-task files in .agent/tasks/
[ ] Phase 3: Generate .agent/TASKS.md
[ ] Phase 3: Generate .agent/README.md
[ ] Phase 3: Generate .claude/CLAUDE.md
[ ] Phase 3: Generate .claude/rules/ files
[ ] Phase 4: Run quality checklist
[ ] Present summary to user
```
