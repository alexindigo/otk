# OTK — Open Terminal Kit

A lightweight browser client for multiple coding-agent servers. One Deno sidecar
sits beside each opencode 1.x server, converts its content into OTK shapes, and
distributes a small live session index. Message history remains in opencode; the
sidecar reads its database only for queries the API cannot answer cheaply.

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

Development verification runs in the dedicated OTK VM on ark, in
`/home/tester/otk`; see the user-level `otk-vm` access skill and milestone
plans. The test provider is scripted and uses no real model credentials.

License: LGPL-3.0-only.
