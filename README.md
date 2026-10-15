# OTK — Open Terminal Kit

A lightweight application for coding-agent backends. OTK's Deno core composes
reusable kit modules, serves the browser UI and distributes a small live session
index. Opencode 1.x is the current backend; its native implementation converts
content into OTK shapes and owns history/database queries.

Requires Deno 2.9.6 and opencode 1.18.34. Start opencode separately, then:

```sh
deno task build:web
deno task start
```

Open `http://127.0.0.1:1502/` to choose authentication on first run. Operator
configuration is layered: `defaults/otk.toml` → generated auth state → optional
`config/otk.toml` → `OTK_*` environment variables. Every leaf and its
environment name is documented in the defaults file. `OTK_CONFIG` selects
another operator overlay. Unknown nodes and invalid types fail loudly.

The production Solid UI lists root sessions by sidecar and project. Add further
sidecars in Settings; their indexes merge into the sidebar. Open one session to
stream its transcript, send prompts, or press Esc twice to interrupt. Message
history for the previous session is released on switching. Web assets and fonts
are bundled locally; no dev server or CDN is used.

Pending permissions for the open session and its descendants appear above the
prompt. Allow once, confirm the displayed future grant patterns for Allow
always, or reject with optional feedback. Child requests retain their
originating title.

Typed tool cards show bash output, read/search/fetch/skill operations, file
diffs and diagnostics, todos, read-only questions and subagent progress. Click a
task to open its child; the subagent bar returns to the parent or cycles
siblings. Child sessions are read-only. Code highlighting runs in a shared Shiki
worker with on-demand grammars; session changes release it. The Display menu
persists preferences in the serving sidecar's `otk.db` and updates other
connected tabs. Reverted turns show a file-summary banner.

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
uses server-set HttpOnly cookies. Browser mutations and WebSocket upgrades
require an allowed Origin even in `none` mode. Cross-sidecar browser access
requires that browser's origin in the remote sidecar's `server.origins`. TLS
termination belongs to the operator's reverse proxy.

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

| # | Entry or area                                               | Responsibility                                                                                                               |
| - | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1 | `main.ts`, `defaults/otk.toml`                              | Layered operator/auth-state config, selected native backend and content buffers, bundled asset path, process signal lifetime |
| 2 | `application.ts`                                            | Backend-neutral shipped composition: public store migrations/services and feature-owned core RPC registrations               |
| 3 | `core/`                                                     | Config/auth, reflective HTTP adapters, WS/RPC transport, session index and backend-neutral service lifetime                  |
| 4 | `web/index.html`, `web/src/main.tsx`, `web/src/features.ts` | Browser bootstrap, fonts/provider and public UI feature selection                                                            |
| 5 | `web/src/ui/App.tsx`, `App.css`                             | Application chrome, draft/navigation ownership and injected RPC/data callbacks                                               |
| 6 | `tests/`                                                    | Application units, integration/e2e, shared fixtures, architectural boundaries and standalone reuse consumers                 |
| 7 | `packages/*/tests/`                                         | Library-owned units; application support stays at root                                                                       |

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
