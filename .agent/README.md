# Agent Environment

> Guide for executing development tasks on the blockchain-ts project.

---

## Contents

| File                                        | Purpose                            |
| ------------------------------------------- | ---------------------------------- |
| [TASKS.md](TASKS.md)                       | Task index and project backlog     |
| [tasks/](tasks/)                            | Individual task detail files       |
| [../.claude/CLAUDE.md](../.claude/CLAUDE.md)| Project rules and conventions      |

---

## Quick Start

```
1. Open .agent/TASKS.md
2. Pick a task and create a branch:  git checkout -b feature/<task-id>-<name>
3. Execute the task following its implementation steps
4. Run verification:                 npm run build && npm test
5. Commit:                           git add -A && git commit -m "descriptive message"
6. Push:                             git push -u origin <branch-name>
7. Create PR:                        gh pr create --title "..." --body "..."
8. Mark task as completed in TASKS.md
```

---

## Prerequisites

### Required Tools

| Tool         | Version | Purpose              | Install              |
| ------------ | ------- | -------------------- | -------------------- |
| **Node.js**  | 18+     | Runtime environment  | `brew install node`  |
| **npm**      | 9+      | Package manager      | Included with Node   |
| **Git**      | 2.30+   | Version control      | `brew install git`   |
| **GitHub CLI** | 2.0+  | Create PRs           | `brew install gh`    |

### Verify Setup

```bash
node --version         # Should be 18+
npm --version          # Should be 9+
git --version          # Should be 2.30+
gh --version           # Should be 2.0+
gh auth status         # Should be authenticated
```

---

## Workflow

### Step 1: Create Branch

```bash
git checkout main
git pull origin main
git checkout -b feature/<task-id>-<short-name>
```

**Branch naming examples:**
- `feature/a1-peer-discovery`
- `feature/b1-api-blockchain`
- `feature/d1-logging-cleanup`

### Step 2: Open Task File

Open the task file from `.agent/tasks/` and follow its implementation steps.

### Step 3: Implement

Follow the **Implementation** steps and **Scope** (files to create/modify) from the task file.

### Step 4: Verify

```bash
npm run build
npm test
npm run lint
```

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
- One line per major change
```

**Commit types:**
- `feat` — New feature
- `fix` — Bug fix
- `refactor` — Code restructuring
- `test` — Adding tests
- `chore` — Maintenance

### Step 7: Push and Create PR

```bash
git push -u origin feature/<task-id>-<short-name>

gh pr create \
  --title "feat(scope): brief description" \
  --body "Completes task <ID> from .agent/TASKS.md

## Changes
- List of changes made

## Verification
- [x] npm run build passes
- [x] npm test passes
- [x] npm run lint passes
- [x] All acceptance criteria met"
```

### Step 8: Update Task Status

After PR is merged, update the task status in TASKS.md (`[ ]` → `[x]`).

---

## Guardrails

| Rule                           | Value              | Action                  |
| ------------------------------ | ------------------ | ----------------------- |
| Max files changed per PR       | 8                  | Split into subtasks     |
| Max diff lines (added+removed) | 500                | Split into subtasks     |
| Compile check                  | `npm run build`    | Must pass before PR     |
| Test suite                     | `npm test`         | Must pass before PR     |
| Lint check                     | `npm run lint`     | Must pass before PR     |
| Code review required           | All PRs            | Required before merge   |
| Ambiguity detected             | Missing info       | **STOP and ask user**   |

---

## Quick Reference

| Action            | Command                                                       |
| ----------------- | ------------------------------------------------------------- |
| Create branch     | `git checkout -b feature/<task>`                              |
| Dev mode (watch)  | `npm run dev`                                                 |
| Run node          | `npm start`                                                   |
| Run miner         | `npm run mine`                                                |
| Run tests         | `npm test`                                                    |
| Build             | `npm run build`                                               |
| Lint              | `npm run lint`                                                |
| Lint + fix        | `npm run lint:fix`                                            |
| Commit            | `git add -A && git commit -m "message"`                       |
| Push              | `git push -u origin <branch-name>`                            |
| Create PR         | `gh pr create --title "..." --body "..."`                     |
| Reset changes     | `git checkout .`                                              |
| Delete branch     | `git checkout main && git branch -D <branch>`                 |

---

## Troubleshooting

### Build Errors

```bash
npm run build 2>&1 | head -30    # Check first errors
npm run lint                      # Check for code issues
```

### Test Failures

```bash
npm test -- --verbose             # Detailed output
npm test -- --watch               # Watch mode for debugging
```

### Too Many Changes

```bash
git diff --stat
# If > 8 files or > 500 lines:
git checkout .
# Split the task into subtasks
```

### Wrong Files Modified

```bash
git diff --name-only
git checkout -- src/path/to/File.ts    # Reset specific file
git checkout .                          # Reset all
```

---

## Tips

- Start with independent tasks (A1, A2, B1, C1, C2, C4, D1, D2) that have no dependencies
- Keep task scope tight — follow the guardrails
- Run verification often to catch issues early
- Reference the dependency graph in TASKS.md to plan parallel work
