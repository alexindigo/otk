# OTK — Open Terminal Kit

A lightweight application for coding-agent backends. OTK's Deno core composes
reusable kit modules, serves the browser UI and distributes a small live session
index. Opencode 1.x is the current backend; its native implementation converts
content into OTK shapes and owns history/database queries.

## Alpha: run OTK next to your opencode

Use Deno **2.9.6** and an already-running opencode server on the same machine,
under the same user. Tested with opencode **1.18.34, 1.18.35 and 1.19.3**;
intermediate versions have not each been tested. OTK does not start opencode.
From your OTK checkout, build the browser app:

```sh
deno task build:web
```

Create `config/otk.toml` in the checkout (create `config/` if needed):

```toml
[server]
host = "127.0.0.1"
port = 1502

[harness]
url = "http://127.0.0.1:4097"
username = "opencode"
password = "" # Set to your opencode server's Basic auth password, if enabled.
```

Replace the URL and credentials with those of your existing server. An empty
password disables Basic auth; these are opencode credentials, separate from
OTK's browser login. `OTK_HARNESS_URL`, `OTK_HARNESS_USERNAME` and
`OTK_HARNESS_PASSWORD` override the same settings. If opencode uses a
non-default data directory, also set `harness.db` (or `OTK_HARNESS_DB`) to its
existing `opencode.db`; the default is `$XDG_DATA_HOME/opencode/opencode.db`,
falling back to `~/.local/share/opencode/opencode.db`.

**Bind the alpha to localhost only.** `server.host = "127.0.0.1"` is the shipped
default; its environment override is `OTK_SERVER_HOST`. Do not expose it to your
LAN or the Internet. The security report flags
[WebSocket origin checks](./docs/alpha-security-findings.md#1-websocket-origin-check),
[DNS rebinding](./docs/alpha-security-findings.md#2-dns-rebinding),
[TOTP guessing](./docs/alpha-security-findings.md#3-totp-guessing) and
[Basic credential forwarding](./docs/alpha-security-findings.md#6-basic-credential-forwarding)
(findings 1–3 and 6) for beta work. Loopback reduces exposure; it does not fix
these findings.

Start OTK, then open `http://127.0.0.1:1502/`:

```sh
deno task start
```

On first run, choose **Password**, enter a username and password, and select
**Configure sidecar**. Then log in with those credentials. Setup also offers
**None**, which disables OTK login. Password setup saves a PBKDF2 hash and a
generated signing key in private `auth.toml` in OTK's state directory. Usernames
are case-insensitive. After login, the project list and Sessions view show your
opencode sessions; the live index defaults to the last 30 days.

TOTP is configured in the operator file, not the setup form. After password
setup, add this to `config/otk.toml` and restart OTK:

```toml
[auth]
type = "totp"
totpkey = "replace-with-a-private-random-text-key"
```

The existing username, password hash and signing key remain in `auth.toml`.
Enroll the **base32 encoding of the UTF-8 text** in `totpkey` in your
authenticator (six digits, 30-second interval). There is no QR/enrollment
screen. At login, append the current six-digit code directly to your password,
with no space. The equivalent overrides are `OTK_AUTH_TYPE` and
`OTK_AUTH_TOTPKEY`.

Configuration layers are `defaults/otk.toml` → generated auth state → optional
`config/otk.toml` → `OTK_*` environment variables. `OTK_CONFIG` selects another
operator file. All keys are documented in [the defaults](./defaults/otk.toml);
unknown keys and invalid types stop startup. Keep credential files private.

### Run as a user service

Stop your foreground OTK with Ctrl+C before starting the service. Save this as
`~/.config/systemd/user/otk.service`, replacing `/absolute/path/to/otk` with
your checkout and `/absolute/path/to/deno` with your Deno executable. The PATH
must also include Deno's directory because the start task invokes `deno` itself.
Keep server URL/auth in `config/otk.toml` so the service uses the same settings.

```ini
[Unit]
Description=OTK

[Service]
Type=simple
WorkingDirectory=/absolute/path/to/otk
Environment=PATH=/absolute/path/to/deno-directory:/usr/local/bin:/usr/bin:/bin
ExecStart=/absolute/path/to/deno task start
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now otk.service
```

To update, run these from the checkout:

```sh
git pull --ff-only
deno task build:web
systemctl --user restart otk.service
```

## What OTK reads and writes

| # | Area              | Behavior                                                                                                                                                                                                                                                                               |
| - | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | Opencode database | Opens the existing SQLite database read-only, including live WAL-backed history. It does not migrate or write opencode's DB/WAL.                                                                                                                                                       |
| 2 | Opencode API      | Reads health, global events, session/status metadata and pending permissions/questions; opening a session reads its content and related resources. Startup does not wake idle projects' native instances.                                                                              |
| 3 | Actions           | Sends mutations only for actions you request, such as prompts, session creation, interrupts and permission/question replies. Auto-approve is off by default; explicitly enabling it authorizes ongoing Allow once replies for that session and its helpers, even with no browser open. |
| 4 | OTK state         | Writes its own `auth.toml` and `otk.db` (preferences, inbox/task metadata and approval policy/journal) under `$XDG_STATE_HOME/otk/1502` or `~/.local/state/otk/1502`. The final component follows the configured port; `state.path` / `OTK_STATE_PATH` overrides it.                   |
| 5 | Project templates | Lists direct directory candidates and reads small Git marker files to exclude linked worktrees. No writes, Git commands or recursive repository walk.                                                                                                                                  |

## Known gaps in the alpha

| # | Area                                       | Missing or limited                                                                                                                                                                                                                                                                                                                                                                                                        |
| - | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2 | M5 B: transcript                           | Whole-transcript copy/export. Existing selection Copy remains available.                                                                                                                                                                                                                                                                                                                                                  |
| 3 | M5 C: status dialogs                       | MCP, LSP, formatter, provider-connect and plugin management/status dialogs.                                                                                                                                                                                                                                                                                                                                               |
| 4 | M5 D: stash                                | Prompt stash management. Unsent browser drafts are retained separately.                                                                                                                                                                                                                                                                                                                                                   |
| 5 | M5 E: changes                              | Full changes/diff viewer; inline tool diffs already render.                                                                                                                                                                                                                                                                                                                                                               |
| 6 | M5 F: navigation                           | Quick session switcher. Use the project's Sessions view.                                                                                                                                                                                                                                                                                                                                                                  |
| 7 | Automatic recovery                         | No automatic continue, retry limits or fallback-provider recovery for provider errors. Permission auto-approve is a separate feature.                                                                                                                                                                                                                                                                                     |
| 8 | Stock opencode 1.18.x permission inventory | Observed on 1.18.34: a pending websearch request omitting optional `livecrawl` makes `GET /permission` return 400 (`Expected JSON value, got undefined`). An OTK adapter starting in that state can remain reconnecting without an index or pending-request inventory. Resolve the request in opencode; OTK cannot recover its missing identity from that response. This case has not been requalified on newer versions. |
| 9 | Security                                   | [Ten scanner findings](./docs/alpha-security-findings.md), six medium and four low, await triage and fixes for beta. They are unverified reports, not a completed security audit.                                                                                                                                                                                                                                         |

## Using OTK

The production Solid UI merges projects across connected servers into an inbox.
Each project has an always-visible roll-up light, unread name and visit clock;
the column collapses to a status-light rail that keeps Search in place above the
project lights. Activity restores inactive projects. Discovered projects follow
tracked projects: session-index directories have activity lights; template-only
directories have none. Their persisted disclosure keeps working, blocked and
unseen-finished projects visible even when collapsed. Templates default to
`~/Projects/{project}` and exclude linked Git worktrees. Viewing discovery does
not track it; creating a session or interacting with one does. Add servers and
path templates in Settings; Add project creates an initial session. The centre
provides ordered task tabs, always-visible active-session phantom tabs and a
single replaceable session preview. Pin, double-click or send in a phantom to
make a task. Task breadcrumbs switch sessions and their helpers; the meter shows
reported token usage and whole-session reported cost. The collapsible right
panel hosts feature-registered views; its collapsed rail keeps their icons
available and clicking an icon opens that view. Sessions shows the selected
project's task-grouped parent/child tree with status lights and title search.
Switching projects restores the last session and its task tab, including after
reload; missing or closed sessions fall back to the default project session.
Click to preview or double-click to make a task. Panel width (280–480px) and
selected view persist with its collapsed state per user. Close session in the
context menu or palette releases task membership and the view while keeping the
session in Sessions and the backend. Closing a helper returns to its parent.
Working, blocked and unseen-finished sessions retain a phantom tab until idle
and seen, with an explanation before closing. Open a session to stream its
transcript, send prompts, or press Esc twice to interrupt. Message history for
the previous session is released on switching. Web assets and fonts are bundled
locally; no dev server or CDN is used.

Text fields retain the browser's native context menu for spelling corrections
and dictionary lookup, including ContextMenu and Shift+F10. Elsewhere right
click opens OTK's menu; Shift + right click keeps the native menu. Selection
Copy outside fields remains available in OTK's menu.

Right click a session tab, breadcrumb or Sessions row to Rename in place, Fork
session or Delete. Delete asks for a second press and stops active work first;
Close session keeps the backend session. Compact is available for the shown root
session and uses its next-prompt model. Hover or focus a prompt for Revert to
here and Copy, or a completed reply for Fork from here and Copy. Forks open
through the chosen reply with an empty composer; their files are shared with the
original. Revert rolls back files and conversation using opencode's native
semantics, without confirmation. The joined composer strip lists rolled-back
prompts and files and offers Restore until the next prompt makes the rollback
permanent; Compact also makes it permanent. Undo previous prompt and Redo are in
the palette and available as `/undo` and `/redo`; Undo can interrupt active
work. Recalled content never overwrites an edited draft. Timeline in the right
panel lists the loaded prompts chronologically: click to scroll and focus a
prompt, use the same Revert/Copy actions, or Load earlier prompts to page the
transcript.

Pending permissions for the open session and its descendants take over the
composer. Allow once, confirm the displayed future grant patterns for Allow
always, or reject with optional feedback. Child requests retain their
originating title. Questions use the same composer area and an Answer action.
Background permission notifications show the same exact command, file targets
and requested scope as the approval takeover, before Allow once is used. Each
session retains its unsent browser draft across takeovers, session/tab switches
and history navigation. The browser title follows the selected project and
session.

The composer's Auto-approve shield toggles server-owned permission replies for
that session and its helpers. It is off by default, persists in `otk.db` and
continues with no browser open; each request receives Allow once, not a
permanent backend grant. Auto marks in tabs, breadcrumbs and session rows show
the active policy. The Activity panel records manual and automatic replies,
their exact targets and confirmed, failed or unconfirmed outcomes. The command
palette and `Ctrl/Cmd+Shift+A` expose the same session toggle. While linked,
pending covered requests show a quiet Auto-approving status instead of asking
the browser for a competing reply. Helpers inherit policy; only the parent
session can enable it. Deleting a session removes its saved policy.

Transcript prose, code, diffs and the rounded composer share a centred 46rem
lane. User messages are right-aligned bubbles without role labels. Expandable
work-log folds hold compact tool rows and thinking lines; file targets are
project-relative and a single edit's diff sits directly below its row. One
metadata line per reply shows reported agent/model/timing and charged turn
model-call count, tokens and cost. Work-log headers and reply footers share the
complete turn's first-call start to last-call end. Hover or focus usage for an
ordered model-call table with tool labels, full prompt Context, New input,
output/reasoning/cache tokens, reported cost and call time. Context is New input
plus Cache read and Cache write; its Total sums every call's prompt. The Total
row retains model-priced category costs without counting Context twice in
charged tokens. Long-run detail keeps a compact overview visible above
internally scrolling calls, with pinned column headers and Total. Context bars
compare each prompt to the turn's peak; narrow windows scroll columns while
retaining call identity. Hover/focus detail replaces the native usage tooltip.
Every cost uses two decimals, with positive amounts below one cent shown as
`<$0.01` and `$0.00` reserved for actual zero. Exact amounts remain accessible
without a native tooltip. Display's Show cost toggle hides cost figures while
keeping tokens. Tool summaries expand to the existing renderers; file changes
start collapsed with their path and reported change counts in the header.
Display's Collapse file changes toggle restores expanded defaults; helper cards
start expanded. Typed tool cards show bash output, read/search/fetch/skill
operations, file diffs and diagnostics, todos, read-only questions and subagent
progress. Click a task to open its child; the subagent bar returns to the parent
or cycles siblings. Child sessions are read-only. Code highlighting runs in a
shared Shiki worker with on-demand grammars; session changes release it. The
Display menu persists preferences in the serving sidecar's `otk.db` and updates
other connected tabs. Reverted turns appear in the joined composer strip.

Pasted or dropped images appear once as thumbnail attachment chips, separate
from prompt text. Image-only prompts can be sent directly. Sent images render as
transcript thumbnails; click one to open its original in the shared image
dialog. Other files retain their file chips. Editing prompt text preserves
independent image attachments until they are explicitly removed or sent.

| #  | Setting                               | Environment variable                                       | Shipped value                                                                  |
| -- | ------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1  | Listener                              | `OTK_SERVER_HOST`, `OTK_SERVER_PORT`                       | `127.0.0.1`, `1502`                                                            |
| 2  | Additional browser origins            | `OTK_SERVER_ORIGINS`                                       | Empty list                                                                     |
| 3  | Authentication                        | `OTK_AUTH_TYPE`                                            | First-run setup; `none`, `password`, `totp`                                    |
| 4  | Credentials                           | `OTK_AUTH_USERNAME`, `OTK_AUTH_PASSWORD`                   | Empty; setup stores PBKDF2 hash                                                |
| 5  | JWT / TOTP keys                       | `OTK_AUTH_SECRETKEY`, `OTK_AUTH_TOTPKEY`                   | Empty; setup generates JWT key                                                 |
| 6  | State directory                       | `OTK_STATE_PATH`                                           | `$XDG_STATE_HOME/otk/<port>` or `~/.local/state/otk/<port>`                    |
| 7  | Harness URL                           | `OTK_HARNESS_URL`                                          | `http://127.0.0.1:4097`                                                        |
| 8  | Harness Basic auth                    | `OTK_HARNESS_USERNAME`, `OTK_HARNESS_PASSWORD`             | `opencode`, empty password                                                     |
| 9  | Harness database                      | `OTK_HARNESS_DB`                                           | `$XDG_DATA_HOME/opencode/opencode.db` or `~/.local/share/opencode/opencode.db` |
| 10 | Heartbeat timeout / reconnect ceiling | `OTK_HARNESS_HEARTBEATTIMEOUT`, `OTK_HARNESS_RECONNECTMAX` | 25 / 30 seconds                                                                |
| 11 | Index window                          | `OTK_INDEX_DAYS`                                           | 30 days                                                                        |

API endpoints live under `/api/`; everything else is static UI. Authentication
uses server-set HttpOnly cookies. Browser mutations and WebSocket upgrades have
Origin checks, with [known alpha gaps](./docs/alpha-security-findings.md).
Cross-sidecar browser access requires that browser's origin in the remote
sidecar's `server.origins`. TLS termination belongs to the operator's reverse
proxy.

The conventional port for a second sidecar is `31502` (set
`OTK_SERVER_PORT=31502`). The sidecar binds exactly its configured port and
exits with an error if it is occupied; it never switches to a fallback port.

WebSocket clients reply `{t:"pong"}` to the sidecar's `{t:"ping"}` JSON
heartbeat every 20 seconds. Connections close after 60 seconds without an
incoming response or other valid client frame. This is an application-level
heartbeat, not a WebSocket control-frame ping.

Development verification runs inside virtual machine
`arch-niri-otk-devbase-otk-m1` on `ark.home`, as `tester` in `/home/tester/otk`,
through the strict `otk-vm` / `otk-m1` access profile and milestone plans. The
test provider is scripted and uses no real model credentials.

License: LGPL-3.0-only.

## Workspace packages

OTK composes seven reusable Deno workspace libraries and one root application.
[`@otk/protocol`](./packages/protocol/README.md) provides dependency-free wire
contracts and helpers; [`@otk/content`](./packages/content/README.md) converts
markdown and patches and owns streaming reply buffers.
[`@otk/harness`](./packages/harness/README.md) provides harness-neutral core and
optional capabilities;
[`@otk/harness-opencode1`](./packages/harness-opencode1/README.md) owns the
stock native adapter and read-only history. Consumers use public bare imports
through each package's `mod.ts`. [`@otk/store`](./packages/store/README.md)
provides feature-contributed persistence migrations. Root `main.ts`,
`application.ts` and the [`application core`](./core/README.md) compose these
libraries, the selected backend, registered RPC features and web assets. HTTP
routes remain reflective application files; core is not another reusable
server/app package. [`@otk/client`](./packages/client/README.md) supplies
framework-free networking, RPC, observable session/index state, history and
navigation. Solid bindings stay at the browser UI boundary.
[`@otk/ui`](./packages/ui/README.md) provides Solid components, consumer-owned
tool/part/prompt/dock registrations, component styles and the client bindings.
The web application selects its modules in `web/src/features.ts`.

The browser application selects public notification channels and injects live
focus, viewed root, host preferences and command/RPC callbacks. Background root
completion, errors and family input edges use one replaceable note per sidecar
and root; each connection's first index snapshot is silent. Settings saves
in-page messages and favicon attention badges on by default, browser OS
notifications and sound off. OS opt-in requests actual browser permission;
blocked/unavailable status remains visible and in-page fallback continues.
Notification actions share guarded session navigation and background-family
permission commands, preserving draft and URL/state ownership. No service worker
or Web Push is required.

## Application ownership

| # | Entry or area                                                            | Responsibility                                                                                                                                                           |
| - | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 | `main.ts`, `defaults/otk.toml`                                           | Layered operator/auth-state config, selected native backend and content buffers, bundled asset path, process signal lifetime                                             |
| 2 | `application.ts`                                                         | Backend-neutral shipped composition: public store migrations/services and feature-owned core RPC registrations                                                           |
| 3 | `core/`                                                                  | Config/auth, reflective HTTP adapters, WS/RPC transport, session index and backend-neutral service lifetime                                                              |
| 4 | `web/index.html`, `web/src/main.tsx`, `web/src/features.ts`              | Browser bootstrap, fonts/provider and public UI feature selection                                                                                                        |
| 5 | `packages/ui/shell/`, `packages/ui/state/shell.ts`, `web/src/ui/App.tsx` | Reusable shell binds framework-free client resource, session-action, input-guard and navigation owners and renders chrome; web composes the public entry and API address |
| 6 | `tests/`                                                                 | Application units, integration/e2e, shared fixtures, architectural boundaries and standalone reuse consumers                                                             |
| 7 | `packages/*/tests/`                                                      | Library-owned units; application support stays at root                                                                                                                   |

Application fixtures use the same composition as production: subprocesses launch
`main.ts`; external-backend fixtures call `startApplication`. Config, wire names
and sidecar browser terminology remain compatible. Core routes stay in
`core/http/routes/`; Pathfinder discovers named handler exports and middleware
without a generated mirror or handwritten route table. Registry machinery
imports no concrete features. Libraries never import the application;
cross-package source imports use only their public `@otk/<library>` entry.

For an alternate backend, implement the public `@otk/harness` contract and
supply it to `startApplication`; optional RPCs follow the capabilities actually
supplied. For a smaller custom application, use `startCore` with selected
feature-owned registrations, as illustrated in the core documentation. Reuse of
a library does not require the OTK application. The browser bundler maps bare
kit names to the declared public entries; UI resources resolve from pinned
library exports.

`deno task test:unit` runs remaining app units and extracted package units;
`deno task test:integration` and `deno task test:e2e` run app-level checks.
`deno task test:arch` enforces extracted package boundaries and
`deno task test:reuse` runs standalone public API consumers. The final kit sweep
adds `deno check packages/<library>/mod.ts` and
`deno publish --dry-run --allow-dirty --config packages/<library>/deno.json` for
all seven actual libraries. The root application is not a separate `@otk/app`,
`@otk/server` or `@otk/sidecar` publication target.
