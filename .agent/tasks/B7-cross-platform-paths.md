# Task B7: Cross-Platform Storage Paths

| Field            | Value                                |
| ---------------- | ------------------------------------ |
| **ID**           | `B7`                                 |
| **Status**       | `[x]`                                |
| **Priority**     | Medium                               |
| **Dependencies** | None                                 |
| **Branch**       | `feature/b7-cross-platform-paths`    |

**Goal:**
Implement platform-aware default storage paths for logs, data, and config so the application follows OS conventions on each platform.

**Current Problems:**

1. **Hardcoded `data/` directory:** The default data directory is relative to the working directory, not an OS-standard location
2. **No platform detection:** No logic to determine the correct storage location per OS
3. **Non-standard on all platforms:** Users expect applications to store data in platform-conventional locations

**Platform Conventions:**

| Platform | Data path                                      | Example                                         |
| -------- | ---------------------------------------------- | ------------------------------------------------ |
| Windows  | `%APPDATA%\blockchain-ts\`                     | `C:\Users\Alice\AppData\Roaming\blockchain-ts\`  |
| macOS    | `~/Library/Application Support/blockchain-ts/` | `/Users/alice/Library/Application Support/blockchain-ts/` |
| Linux    | `~/.blockchain-ts/`                            | `/home/alice/.blockchain-ts/`                    |

**Scope:**

```
src/
├── config.ts                           # MODIFY — add platform path resolution
├── index.ts                            # MODIFY — use resolved default path
├── mine.ts                             # MODIFY — use resolved default path
├── blockchain/
│   └── __tests__/                      # MODIFY — update tests if needed
```

**Implementation:**

1. **Create path resolver in `config.ts`:** Add a `getDefaultDataDir()` function that detects `process.platform` and returns the appropriate base path
   - `win32` → `path.join(process.env.APPDATA || os.homedir(), 'blockchain-ts')`
   - `darwin` → `path.join(os.homedir(), 'Library', 'Application Support', 'blockchain-ts')`
   - `linux` (and other) → `path.join(os.homedir(), '.blockchain-ts')`
2. **Update default data directory:** Replace the hardcoded `data/` default with `getDefaultDataDir()`
3. **Preserve `--datadir` override:** The CLI `--datadir` flag must still override the default
4. **Ensure directory creation:** Create the data directory (and subdirectories like `blocks/`) if they don't exist on first run
5. **Update tests:** Mock `process.platform` and `os.homedir()` to verify correct path resolution per platform

**Acceptance Criteria:**

- [ ] `getDefaultDataDir()` returns correct path for Windows, macOS, and Linux
- [ ] Default data directory uses OS-conventional path when `--datadir` is not specified
- [ ] `--datadir` CLI flag still overrides the default path
- [ ] Data directory and subdirectories are created if they don't exist
- [ ] Paths with spaces (e.g., `Application Support`) are handled correctly
- [ ] Build passes: `npm run build`
- [ ] Tests pass: `npm test`
- [ ] Lint passes: `npm run lint`

**Verification Commands:**

```bash
npm run build
npm test
npm run lint
# Test: run without --datadir — should use OS-standard path
# Test: run with --datadir ./custom — should use custom path
```
