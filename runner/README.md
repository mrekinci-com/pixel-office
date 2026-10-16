# Pixel Office runner

[Turkish guide](README.tr.md) · [Main guide](../README.md)

A Node.js 24 + TypeScript process running on the Linux host, separately from the office container. General installation steps are in the [main guide](../README.md).

Claude supports chat and authorized Office tools, plus restricted Read/Edit/Write at workspace/folder permission levels. The Director can also use an interactive Claude terminal. **Experimental — not tested with a real account.** Native search, shell and web tools remain disabled. Authentication and MCP settings are blocked by CLI/managed deny rules and the file guard. See the [security model](../SECURITY.md).

Requirements: Node.js 24+, Codex CLI ≥0.138 (options tested with 0.159.1); optional Claude Code 2.1.285+ (experimental); Linux `bubblewrap` (`bwrap`), user/PID namespaces, and `/usr/bin/python3` for the Codex shell probe. The smoke probe also needs `/usr/bin/curl`. Real agent work **does not start** without isolation. Installing `bwrap` or disabling isolation is not performed from within this application.

```sh
npm ci --cache .cache/npm
npm run typecheck
npm run build
npm test
```

Prepare `.env` from `.env.example` with permissions 0600. Use the same random `OFIS_RUNNER_KEY` as the office, at least 32 characters. Never put the key in command arguments, logs or the repository. An empty office key disables its internal runner API.

| Variable | Meaning |
| --- | --- |
| `OFIS_URL` | `http://127.0.0.1:9400` or separate test/staging instance `http://127.0.0.1:9401`; other addresses are rejected. |
| `OFIS_RUNNER_KEY` | Shared internal API key; never passed to the model or MCP process. |
| `OFIS_WORK_DIR` | Absolute work root: `<root>/ofis/<agent ID>`; single-run profiles `<root>/.runtime/<run ID>`; task/persistent profiles `<root>/.oturum/<agent>/<generation>`. |
| `OFIS_ALLOWED_ROOTS` | Allowed absolute connection roots, separated by `:`; empty means no connections. |
| `OFIS_PROTECTED_ROOTS` | Additional strictly forbidden roots; the repository and work root are already protected. |
| `OFIS_CONCURRENCY` | Local capacity, default 2; the smaller of this and the panel limit applies. |
| `OFIS_CODEX_MODEL` | Installed model shown as a panel suggestion. Default `gpt-6.1-sol`; no access/quota guarantee. |
| `OFIS_CLAUDE_AUTH_FILE` | Dedicated Claude account's private authentication file; only `claudeAiOauth` is copied. Empty uses `<OFIS_WORK_DIR>/.auth/claude-login/.credentials.json`. |
| `OFIS_CODEX_AUTH_FILE` | Dedicated Codex account's `auth.json`; only authentication fields are copied. |
| `OFIS_CLAUDE_BIN`, `OFIS_CODEX_BIN`, `OFIS_BWRAP_BIN` | Optional executable paths; defaults `claude`, `codex`, `bwrap`. |

Authentication files must belong to a **dedicated service account** with model access. Personal HOME, `.claude`/`.codex` settings, hooks, plugins, skills and sessions are not mounted. A new session gets an empty HOME and copies only required authentication fields. Single-run profiles are removed when the process exits; task and persistent profiles remain until session closure or renewal. Refreshed authentication fields are retained only in the private `.auth/` vault under the work root; personal settings are not retained. The administrator must refresh this cache too when switching accounts. Personal authentication files are never searched automatically. Claude `--bare` disables OAuth and is not used; instead the runner combines `--restricted`, empty setting sources, private HOME and disabled skills/hooks.

Manual startup:

```sh
npm start
```

Adjust the Node path and PATH in `systemd/pixel-office-runner.service.example` for your installation. The corresponding template for a separate test/staging instance is `systemd/pixel-office-runner-test.service.example`; use a separate `.env.test` and work directory. The file is only a prepared example. A single runner service is assumed. SIGTERM/SIGINT stop child processes and release the office registration. A new identity on the same machine and work root can take over after the old identity misses heartbeats for 5 seconds. Other machines/older versions retain the 45-second limit. After a crash, old tasks are retried at most once.

The runner receives the office language on heartbeats and job leases. User-facing diagnostics, generated directory maps and tool descriptions follow that language. Concurrent runs retain their own language context. Tool names, argument keys and protocol values stay unchanged; English descriptions explain required protocol values.

Folders containing private settings, secrets or symbolic links escaping the root are rejected; scans are capped at 50,000 entries.

When a folder connection is created in the panel, the runner validates its real path, deny list and allowed root. Read-only connections are mounted read-only. Approval-protected write connections are also mounted read-only for agents and are not given to Codex as extra writable roots. The agent prepares the same relative path in its own workspace; `onay_iste(baglanti, dosyalar)` records contents and before/after differences. After approval, the runner copies the saved bytes; later workspace changes do not change approved content. Changed targets or symbolic-link paths are rejected. Multi-file copying is not one database transaction; interrupted copies are not retried automatically.

Each file is limited to 1 MB; a delivery/approval can contain at most 20 files. Secret files and text containing known secrets cannot be delivered. `onay_iste(dosyalar)` without a connection creates immutable attachments and grants no copy permission. See the [main guide](../README.md) for security boundaries.

Tests make no real model calls and open no listening HTTP ports. A fake CLI talks to real stdio MCP; only the test file bridge forwards requests to Fastify `inject`. Production does not use this bridge/launcher and has no environment switch for disabling isolation.

Codex uses a shell with workspace/folder permissions; it is disabled for chat-only agents. Before every run, a model-free sandbox probe uses **the same outer bwrap mounts and Codex settings**. Runs start only if IPv4/IPv6 TCP and IPv4 UDP sockets are rejected with EPERM/EACCES. Timeouts, empty output, other errors or connection refusal alone do not count as success. The shell receives only PATH=/usr/bin:/bin, private HOME/TMPDIR and LANG=C.UTF-8. A successful probe is not a mathematical guarantee for later CLI behavior.

**Command networking is disabled.** The panel switch cannot be enabled, the server rejects new network permission, and the runner rejects old permission too. Outer bwrap still shares host networking for the model and MCP. This version has no process-wide domain/local-IP egress filter. A separate network namespace + Unix MCP bridge + CONNECT proxy is not implemented. The CLI's agent-specific profile contains service account authentication; the shell denies access to that profile. A real probe must verify denial before work starts. Personal settings are not copied.

Run a real smoke check only when a separate test/staging instance and runner are ready:

```sh
npm run smoke:real -- --ofis-url http://127.0.0.1:9401 --work-dir "$PWD/work-test" --runner codex
npm run smoke:real -- --ofis-url http://127.0.0.1:9401 --work-dir "$PWD/work-test" --runner claude
npm run smoke:real -- --ofis-url http://127.0.0.1:9401 --work-dir "$PWD/work-test" --runner all
```

For port 9401 the script reads `office/.env.test` and `runner/.env.test`. Port 9400 additionally requires `--canli` and uses `.env`. Agent Tududi must use 9393. Service and script must share `OFIS_WORK_DIR`/`OFIS_ALLOWED_ROOTS`. Tests use temporary folders inside the allowed root. Existing agents, departments and rules are preserved. Office-wide quota/load may prevent tests; the script does not raise limits.

At most 90 model runs. Comparing 2 and 6 steps across three session modes needs 48 runs for both providers alone. Preparation/renewal and budget retries are included in comparison totals. The first run combines reply/memory/file/Tududi actions; handoffs use two runs, approval+rejection three, connections two and chains two. Isolation probes do not call models. The script prints an English PASS/FAIL table, time, tokens and redacted diagnostics; any failure returns exit code 1. `--keep` preserves only new test records and still stops active work. Normal cleanup does not delete an agent before process exit is confirmed. Process/account deletion errors retain records and mark failure. SIGTERM/SIGINT also enter cleanup; SIGKILL/power loss cannot be guaranteed.

`--runner claude` reports file and shell scenarios as untested; those require Codex. Mixed-provider file handoffs are also untested. Without Claude account authentication, its check does not start. Authentication fields alone do not prove a valid account or model access.

## Separate sandbox tests and persistent sessions

`npm run test:box` uses the configured real bwrap to check Node/dependency reads, write boundaries, absence of external network interfaces, timeout and stopping in repository-local temporary folders. It makes no Office/Tududi/model requests and downloads no dependencies. Temporary folders are removed. It uses the bwrap path in local `.env` and runs separately from fake CLI tests.

The smoke driver defaults to 127.0.0.1:9401 and `.env.test`. `--work-dir` is required; a live office also requires `--canli`. Create the work root and `runner/test-code` beforehand. Preparation and real CLI limitations are described in the [main guide](../README.md).

Persistent profiles are stored with mode 0700 under `.oturum/<agent>/<generation>`. Single-run profiles are removed after completion. Model lists are not discovered from accounts automatically; fill `OFIS_CODEX_MODELS` and `OFIS_CLAUDE_MODELS` with models the account can actually use.

## Per-task sessions and measurement

The default is a session per task. Continuation of the same task keeps its provider identity; new work starts a fresh conversation. Profiles of open tasks coexist. Renewal thresholds are 12 turns / 150,000 input tokens in the last run. If a run exceeds its budget, the same task is retried once in a fresh session. Build office and runner from the same source version.

Each smoke comparison mode/step count uses a separate temporary agent. Comparison agents for one provider are created together before measurement so the directory does not grow halfway through. Scenarios start with fresh sessions. `token-karsilastirma.json` records total, cached and uncached usage and all runs. `simulated:true` is not real token savings. Real daily/chain budgets are never increased; a scenario fails if they are insufficient.

`npm run test:box` also verifies, without model calls, that the Codex sandbox rejects direct writes to approval-protected folders and that Claude file jobs are refused before launch. A model saying it refused is not isolation evidence. Claude agents have not been verified with a real account.


## Experimental Claude support

**Claude support is experimental — not tested with a real account.** Agents and the Director terminal use Claude Code 2.1.285+ with isolated `CLAUDE_CONFIG_DIR`, strict Office MCP configuration, stdin for headless prompts, stable session IDs/resume, and provider-specific usage. Models default to `sonnet,opus,haiku`; thinking levels map to `--effort` and remain model-dependent. Each user must check their subscription's automation terms.

The installer and panel print the dedicated login command. It clears inherited credential variables with `env -i` and uses a new home/config directory at `<OFIS_WORK_DIR>/.auth/claude-login`. Never connect personal `~/.claude`. Keep `OFIS_CLAUDE_AUTH_FILE` empty for this default, or set a dedicated file. The Director asks the owner to complete any theme/trust screen; no automatic trust/bypass choice is made. Authentication failures show the separate login command.

Read/Edit/Write are available only at file permission levels. Native shell, search and web remain off. Both the read-only Linux managed policy and CLI deny rules block authentication/MCP/settings paths; a managed PreToolUse guard additionally rejects aliases, unsafe files and unauthorized writes. Version/help and exact-policy checks are offline; the tests do not establish real Claude enforcement. The Codex managed permission probes remain unchanged. There is no process-wide Anthropic-domain proxy; the outer CLI and MCP still share host networking.

Claude terminal lifecycle comes from managed UserPromptSubmit/Stop hooks. Its transcript reader deduplicates message usage, includes cache creation/read fields, and refuses partial totals from records above 8 MiB. Unknown usage disables automatic follow-up. Both components must use protocol **11**. See [the C1 delivery](../docs/asama-c1-teslim.md) for tested behavior and limits.

Persistent Director terminals have no wall-clock session timeout or daily duration cap. Office renews their short liveness leases while connected. Token and tool-call caps remain enforced by Office; ordinary headless work still uses its configured timeout.
