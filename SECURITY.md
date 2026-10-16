# Security policy

## Supported versions and reporting

Pixel Office is pre-release software. Security fixes target the current source
revision; older revisions are not maintained as separate security branches.
Keep the Office and runner on the same revision and rebuild both after updates.

Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/mrekinci-com/pixel-office/security/advisories).
Use **Report a vulnerability** to provide the affected revision, installation
layout, required privileges, impact, and a minimal reproduction with dummy data.
Do not include real credentials, authentication profiles, database files, or
customer data. Please avoid public issues or pull requests containing an
unpatched exploit. Reports are reviewed on a best-effort basis; there is no
guaranteed response time or bug bounty.

## Supported installation

The supported runner environment is Linux with Node.js 24 or later, working
Bubblewrap user/PID namespaces, Python 3, and a compatible Codex CLI. Terminal
mode also requires tmux. CLI versions are security dependencies: the runner
refuses shell/terminal launch when its sandbox probes do not establish the
required restrictions. There is no production fallback without isolation.

Run the runner as a dedicated, unprivileged OS user with dedicated provider
credentials, a private work directory, and narrowly selected folder roots. Do
not give it Docker access, sudo rights, personal provider profiles, or unrelated
application credentials. The adapted Tududi instance must be a separate
installation with its own database, uploads, administrator, and session secret.
The external Tududi image and its operating-system packages require their own
security maintenance; this repository does not contain that image's source.

Office defaults to `127.0.0.1`. The supplied Office image runs as `node`, listens
on the container interface explicitly, and is used with dropped capabilities,
`no-new-privileges`, and a read-only root filesystem. The supplied Compose file
publishes Office and Tududi on loopback by default. Keep the Tududi backend and
access proxy on loopback or a trusted private network. A private IP is a binding
restriction, not authentication or encryption.

For remote Office access, use an HTTPS reverse proxy and set `OFIS_PUBLIC_URL`
to the exact browser origin. HTTPS origins force Secure cookies even if
`OFIS_COOKIE_SECURE` was left false. Preserve the browser's Origin header and
WebSocket upgrades; do not enable permissive CORS. Configure TLS and HSTS at the
reverse proxy. Forwarded client-IP headers are not trusted by the application.
Do not publish the Vite development server or the runner API separately. The
same-host, private-address Tududi transition is the supported ticket flow;
different-domain/public HTTPS Tududi transitions need separate validation.

`scripts/install.sh` only prepares local settings. It generates secrets with the OS
cryptographic random generator and creates private configuration files with
mode 0600. It refuses linked managed paths and overly broad permissions on
existing secret files. Keep configuration, data, work profiles, and backups out
of source control and shared folders.

## Trust and authorization

* **Owner:** a fully trusted administrator. The owner can delegate filesystem
  writes, configure commands, manage accounts, and erase application records.
  Owner sessions use signed HttpOnly, SameSite=Strict cookies, hashed server-side
  tokens, a 12-hour expiry, and explicit logout revocation. Password comparisons
  use constant-time comparison of fixed-size hashes. Login attempts are limited.
  Mutating owner requests require `X-Ofis-Islem: 1`; supplied origins must match
  the configured origin. URL decoding is applied before choosing the owner,
  runner, or agent authentication boundary. Ambiguous separator/dot paths are
  rejected.
* **Office and runner:** trusted components controlled by the same operator.
  The shared runner key is a high-privilege service credential, not an agent
  credential. Runner calls require that key; protocol versions, active runner
  identity, and run ownership are checked. Agent tools use run-scoped lease
  tokens with expiry and active-agent checks. Terminal credentials are scoped to
  the Director and terminal generation; operations also depend on the current
  runner/run state. Do not share one runner between mutually untrusted owners.
* **Agents and Director:** model output is untrusted. Management tools require
  the built-in Director identity and are authorized on the server. Ordinary
  agent tokens cannot become owner or runner tokens. New/modified command
  definitions and expansion of an existing folder assignment always require
  an owner decision. The Director cannot approve those proposals itself.
  Other approval categories and destructive-operation delegation follow the
  owner's settings. Pending settings proposals preserve the owner's current
  approval restrictions. A factory-reset proposal only opens a preview;
  execution still requires an owner session and the explicit confirmation word.

The browser terminal requires both an owner session and a short-lived,
single-use, session-bound ticket with an exact Origin match. Runner WebSocket
connections require the service key, a current runner heartbeat, and the
protocol version; browser Origin headers are refused there. Payload sizes,
browser input rate, and output buffers are bounded. Logout/expiry closes browser
access; stopping model work is a separate owner action.

## Filesystem and network boundaries

The outer Bubblewrap filesystem exposes selected runtime files, the agent's own
workspace/profile, and validated folder links. Personal homes and other agents'
profiles are not mounted. Configured protected roots are checked through both
their configured and real paths. Broad roots, sensitive configuration paths,
outward symlinks, hard-linked files, and special files are refused. Incoming
files and directory maps are read-only in the agent box. Managed profile writes
refuse links and replace files privately rather than following existing targets.

Codex shell commands run inside an additional permission sandbox. That sandbox
denies access to the provider/MCP profile and network sockets; the actual launch
configuration is probed before use. Terminal mode additionally loads a
read-only managed policy and checks that unrestricted permissions cannot be
selected. Fixed registered commands run in a separate Bubblewrap box with an
isolated network namespace, a filtered environment, fixed command text, and
only the assigned folder; dependency directories are mounted read-only.

The trusted provider CLI and Office MCP bridge need network connectivity, so
the outer provider process does not have a general egress allowlist. Arbitrary
agent network access remains disabled: `network: true` is refused. There is no
general-purpose agent web proxy. The provider CLI and MCP implementation are
part of the trusted computing base, alongside the kernel and Bubblewrap.

Claude agents and the Director terminal are **experimental — not tested with a real account**. Every user must check their subscription's automation terms. Only a dedicated OAuth credentials copy is used; the runner never copies personal settings or hooks. Use the isolated sign-in command shown by the installer/panel, not your personal `~/.claude`.

Claude Code 2.1.285+ runs with `--restricted`, an explicit native tool list and strict Office-only MCP configuration. Chat has no native tools; file levels expose only Read/Edit/Write. Shell, native search, web, subagents and skills remain disabled. The read-only managed policy disables bypass/auto modes and blocks profile, `/proc`, `/etc` and `/opt` reads/edits; the same deny rules are also CLI arguments. A managed PreToolUse guard rejects paths outside the assigned roots, credentials/settings, symlinks, hard links, read-only/approval-protected writes, incoming-file edits and directory-map edits. Policy, its source alias, MCP configuration and guard input are mounted read-only after the writable profile. Settings and hook code are outside the permitted document roots.

The file guard is a second check alongside native permissions and restricted mode, not a replacement for them. In the installed 2.1.285 CLI, a timed-out or unstartable command hook can fail open; the wrapper maps ordinary process failures to blocking exit 2, while native path deny rules remain mandatory independently. Startup verifies the exact policy and arguments and the version/help capabilities before launch; malformed or weakened policy refuses launch. Positive/negative validator and real guard-process tests use fake credentials, and a fake Claude exercises the supervisor and MCP. No real Claude permission enforcement, account, model response or full Bubblewrap/Claude combination has been tested. New CLI releases and provider-side policy changes require review.

The outer CLI's network remains part of the trusted computing base. This repository has no provider-domain egress proxy; adding Anthropic hostnames to a nonexistent allowlist would not enforce a boundary. Agent web/shell tools and arbitrary network permission remain disabled. Do not describe this as a process-wide domain or local-IP firewall.

File delivery uses relative paths, bounded immutable contents, and hashes.
Broker reads pin directory descriptors and refuse symlinks/hard links. Approved
copies recheck destination contents before replacement; copies are serialized
against active agent jobs. Folder trees and installer directories must not be
modified concurrently by untrusted host processes. This is not an isolation
boundary against root or another process running as the runner's OS user.

## Untrusted content and sensitive data

Agent results, task descriptions, Tududi notes, files, and remembered context
can carry prompt injections. Prompts identify them as data, and automatic
Director summaries serialize them separately from server instructions. These
labels do not guarantee that a model will ignore malicious instructions.
Server-side tool, folder, command, and approval checks enforce the boundary;
review what is being approved, not an agent's claim that approval was obtained.
Read access also permits content to be sent to the selected model provider.

Markdown renders through escaped React nodes without raw HTML; links allow
only HTTP(S) and mailto and use opener protection. HTML/SVG deliveries are served
as plain text or downloaded attachments, with `nosniff` and a restrictive CSP.
The Tududi access proxy has a fixed local upstream and filters Office session
cookies; it relies on the separate Tududi application's authentication.
Transition tickets are short-lived, single-use, and bound to an owner session.

Stored Tududi credentials and factory-reset inventories/backups are encrypted
with AES-256-GCM and record-specific authenticated context. Reset previews and
backup downloads are owner-session-bound. Downloaded backups contain private
application content and must be protected by the owner. Encryption of account
fields does not encrypt the whole database or provider authentication profiles.

Known application/provider credentials are masked before new messages, events,
tool logs, and terminal output are published. This includes split terminal
chunks and common credential formats. Masking is defense in depth: it cannot
recognize every secret, encoded value, screenshot, or arbitrary confidential
document. Never attach secret-bearing folders merely because masking exists.
Keep logs and backups private and apply operating-system storage/retention
limits to the runner account.

## Verification scope

The G3 review uses source inspection, in-process HTTP/WebSocket injection,
dummy credentials, mock provider/Tududi implementations, package audits, type
checks, and builds. It does not certify a running deployment, an external
Tududi image, a kernel, a provider CLI release, or a reverse-proxy configuration.
Production dependency audits are time-specific; a clean npm audit is not a
guarantee that all vulnerabilities are known. The Turkish review and validation
record is in [the G3 delivery report](docs/asama-g3-teslim.md).
