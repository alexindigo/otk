# Changelog

## [0.1.0-beta.1] — 2026-10-26

**Highlights.** Sessions gain in-place rename, confirmed deletion, inclusive
forking, compaction, revert/restore, undo/redo and a prompt timeline. Native
session actions share guarded navigation and preserve newer draft edits. Every
install channel now uses one compiled executable and a systemd user unit; OTK
discovers the user's XDG config itself. A shared build recipe produces Linux
x86_64 and aarch64 release archives with checksums (`fbedde9`, `b25738c`,
`c24f9e5`, `7f98acf`, `ae7232f`, `7b4cce3`, `d93f3db`, `6fabeec`, `dc45651`).

**Known gaps.** Whole-transcript copy/export, MCP/LSP/formatter/provider/plugin
dialogs, prompt stash management, a full changes viewer and a quick session
switcher remain missing. Inline diffs, selection Copy, retained browser drafts
and the Sessions view remain available. There is no automatic continue,
retry-limit or fallback-provider recovery. On stock opencode 1.18.34, a pending
websearch permission missing optional `livecrawl` metadata can make
`GET /permission` return 400 and leave OTK reconnecting without an index;
resolve that request in opencode. This case has not been requalified on newer
versions (`91d27da`, `d93f3db`).

All ten security scanner findings remain open and unverified; keep OTK bound to
localhost. See the
[install instructions](./README.md#install-run-otk-next-to-your-opencode),
[security findings](./docs/security-findings.md) and
[packaging recipe](./packaging/README.md) (`91d27da`, `dc45651`).

### 2026-10-25

#### Fix

Compaction appears as a transcript marker rather than a user prompt bubble, and
the palette lists only currently available commands. These changes make session
state and available actions clearer without changing native semantics.

- Frame compaction markers separately from ordinary prompt content (`9b5e014`).
- Omit unavailable commands from the palette (`aa6501a`).

#### Feature

Sessions can be renamed in place, deleted with a second press, forked through a
selected reply and compacted with the next-prompt model. Revert and restore
expose native rollback, while undo/redo wait for authoritative transcript
publication and preserve independently edited drafts. The timeline navigates
loaded prompts and can load earlier history; OTK also finds the optional XDG
operator file without a packaging launcher.

- Rename sessions in place (`fbedde9`).
- Delete sessions while guarding unsaved family drafts (`b25738c`).
- Fork complete sessions or through a chosen reply (`c24f9e5`).
- Compact sessions using the selected model (`7f98acf`).
- Revert to a prompt and restore rolled-back conversation (`ae7232f`).
- Undo and redo prompts without overwriting newer drafts (`7b4cce3`).
- Navigate prompts in the timeline panel (`d93f3db`).
- Discover the operator config in the XDG config directory (`6fabeec`).

#### Refactor

Popover hover and focus lifetimes share one intent owner, including portalled
regions and cancellation. This centralizes interaction timing without adding a
new visible control.

- Share the hover-intent owner (`c3b35fa`).

#### Build

Source packages and release automation use the same frozen compile recipe,
embedding browser assets, reflective routes, defaults and migrations. The
release workflow builds both Linux architectures and publishes checksummed
archives containing the executable and shared systemd user unit.

- Add the compiled binary recipe, service and release workflow (`dc45651`).

## [0.1.0-alpha.1] — 2026-10-24

**Highlights.** OTK (Open Terminal Kit) is a browser workspace for coding-agent
backends, starting with opencode 1.x. This first alpha brings a live project
inbox, task and session tabs, streamed transcripts, tool output and inline
diffs, prompt attachments, model and agent choices, permission replies, and
usage and cost details. It runs alongside an existing opencode server;
permission auto-approve is off by default (`9906cdf`, `5bb31d7`, `99c4e2a`,
`d97e5ab`, `3afd8e8`, `9dc5c8d`, `4ffc1a8`, `9aee744`).

**Known gaps.** Session revert, undo/redo, fork, rename, delete, compact and
timeline controls are missing; Close session releases only the OTK view and task
membership. Whole-transcript copy/export, MCP/LSP/formatter/provider/plugin
dialogs, prompt stash management, a full changes viewer and a quick session
switcher are also missing. Inline diffs, selection Copy, unsent browser drafts
and the Sessions view remain available (`91d27da`).

There is no automatic continue, retry-limit or fallback-provider recovery. On
stock opencode 1.18.34, a pending websearch permission without optional
`livecrawl` metadata can make `GET /permission` return 400 and leave OTK
reconnecting without an index; resolve that request in opencode. This case has
not been requalified on newer versions. Ten unverified security scanner findings
(six medium, four low) remain open, awaiting triage; keep this alpha bound to
localhost (`91d27da`).

See the
[README install instructions](./README.md#install-run-otk-next-to-your-opencode)
and [security findings](./docs/security-findings.md) before installing
(`91d27da`).

### 2026-10-24

#### Fix

Text fields keep the browser's spelling and dictionary menu, and long control
labels stay readable without overlapping actions. Recovery and cleanup now
respect the session or connection that owns the work, while secondary failures
no longer make accepted actions look unsuccessful.

- Preserve native context menus in text fields (`c7d3ac3`).
- Keep control labels on one line and wrap whole controls when needed
  (`ae78d86`).
- Release connection, session, usage and service resources with their owners
  (`e20a679`).
- Retain usable transcripts through recovery failures and report interaction
  errors locally (`387ce86`).
- Separate bookkeeping and observer failures from successful actions and saved
  changes (`9566f09`).

#### Feature

The inbox now shows discovered projects separately from tracked projects and
restores the last session when returning to a project. Session closing keeps
backend history intact, and attention lights make blocked or unseen-finished
work easier to notice. Hover details wait for deliberate pointer intent.

- Give working sessions a slow green breathing glow (`e0eefbc`).
- Remember each project's last session and task across reloads (`4033d6d`).
- Theme session lights separately from connection-health and tool-activity
  indicators (`598662c`).
- Prioritize needs-you and unseen-finished states in project and task lights
  (`ae4da3d`).
- Close a session view without deleting its backend session (`7036c9c`).
- Delay hover previews while keeping keyboard and explicit opening immediate
  (`ce6fa9f`).
- Show index and template discoveries without tracking them until an action
  (`6016d44`).

#### Refactor

Unused styles and highlighting paths were removed to keep the implementation
focused on its active owners. This cleanup does not add a user-facing feature.

- Remove orphaned code and clarify highlighting and test intent (`e1c3a1b`).

#### Test

Compatibility fixtures can select the native opencode binary, and passive-safety
coverage checks manual approvals and read-only live-WAL history. Layout,
architecture and dependency checks now use explicit readiness and isolated
inputs rather than timing or live-registry assumptions.

- Add native-version selection and passive-safety coverage (`ece5a73`).
- Wait for saved layout before browser geometry measurements (`7a6c542`).
- Resolve architecture-scanner bindings by lexical identity (`abee4e4`).
- Isolate uncached dependency checks from live registries (`d93af7f`).

#### Docs

The alpha installation guide explains how to connect to an existing opencode
server, configure login and run OTK as a user service. It also documents data
access, missing features and the outstanding scanner findings.

- Document alpha installation, safety boundaries and known gaps (`91d27da`).

### 2026-10-23

#### Fix

Prompt history and editor changes preserve the chosen agent, model and variant.
Dialog dismissal and keyboard hints now follow their current owners, while
shared components keep their own styles and backend metadata stays independent
of the browser theme. Error handling also accepts thrown values beyond ordinary
Error objects and rejects unresolved empty state paths.

- Make error feedback and state-path validation explicit (`c8b7b86`).
- Derive shortcut hints from the active key bindings (`fee3394`).
- Keep agent colours, missing identities and truncation metadata backend-neutral
  (`09a921c`).
- Encapsulate prose, work-log, change-count and component styling (`0c4dab9`).
- Preserve prompt choices through history, editor and clear operations
  (`61d21a8`).
- Bind asynchronous dialog dismissal to the dialog that requested it
  (`0c6df54`).

#### Refactor

Shared control, catalog and transaction owners replace repeated implementations.
Typography, chrome dimensions, interaction timing and highlighting groups each
have one source of truth. Project discovery and prompt completion move into
framework-free client owners so other consumers can reuse the same behavior.

- Share preference controls, resize lifetimes, file-change presentation and
  icons (`f63ecef`).
- Share catalog resource lifetimes and database transactions (`57cf2c7`).
- Centralize chrome dimensions and validated resize bounds (`d03001a`).
- Share typography sizes and line metrics across components (`6245a88`).
- Keep interaction deadlines with the components that use them (`e1b13d1`).
- Share the highlighting row-group policy across worker and renderer
  (`e9b5d34`).
- Move project discovery and addition into the client (`0be9cee`).
- Move prompt-completion arbitration and cancellation into the client
  (`40f9b87`).

#### Test

Architecture tests now check that all submission modes pass through the shared
session owner. Heap checks inspect retained objects more closely to distinguish
real leaks from transient allocations; these changes affect verification only.

- Enforce shared session-submission ownership (`c3eb750`).
- Strengthen heap-snapshot retention measurements (`2f5c7dd`).

### 2026-10-22

#### Fix

Startup inventories avoid waking idle projects when compatible database hints
are available, and one directory's failure no longer blocks healthy directories.
Menus and dialogs keep the right bounds and invocation identity. Prompt sends
and task-membership edits use shared operations so concurrent UI actions cannot
silently replace each other's work.

- Scope native inventories and contain per-directory failures (`a340f0d`).
- Size native popovers to their visible surface (`35a16f4`).
- Keep dialog state bound to its invocation (`c148348`).
- Share submission admission across prompts, shell and native commands
  (`8ed5c6a`).
- Apply task additions and removals as operations on current saved membership
  (`beffeb3`).

#### Refactor

Navigation, session-target actions and per-server resources now live in plain
client modules. The UI forwards intent to those owners, preserving the same
draft guards and navigation behavior for reusable consumers.

- Move guarded navigation and session creation into the client (`b894aca`).
- Share session-target operations through one client owner (`5081143`).
- Move per-server shell resources into the client (`43ca3e5`).

#### Test

Browser performance checks measure streaming and retention through explicit
resource lifetimes. Fixture preparation, cleanup and configuration are shared,
and architecture scanners parse bindings and syntax instead of matching source
spelling. These changes strengthen the evidence without adding product features.

- Measure free-running streaming latency (`afbc633`).
- Prepare shared native packages before dependent fixture tasks (`acf975e`).
- Check architecture ownership rather than source text (`26d779c`).
- Parse code and styles in architecture scanners (`93ec787`).
- Give integration tests unique IDs and check for duplicates (`b8f9fff`).
- Merge fixture overrides by leaf while retaining the assigned port (`366359d`).
- Bind fixtures and prepared native packages to explicit resource lifetimes
  (`0388263`).
- Tie browser measurements to the resources being measured (`43c8656`).

### 2026-10-21

#### Fix

Configuration resolves the state directory once, and sending fails clearly if a
selected attachment cannot be read. Native requests and event streams are
cancelled with their connection, and activity bootstrap remains available when
SQLite cannot supply hints.

- Resolve the state directory before its consumers open files (`f909409`).
- Require every selected attachment instead of silently omitting one
  (`9282004`).
- Cancel native reads and event work with their connection (`bc6ae49`).
- Bootstrap running and blocked activity independently of SQLite availability
  (`5a3f196`).

#### Feature

Context menus now expose actions for the part of the workspace under the pointer
or keyboard focus. Session, project, message, code and tool actions reuse the
same commands as visible controls, including source copy and usage details.

- Add workspace-area actions for projects, panels, composer and transcript space
  (`95207b5`).
- Add context actions for sessions, projects, messages, code, diffs and tools
  (`c312d31`).

### 2026-10-20

#### Fix

Keyboard focus paint now belongs to visible controls and content rather than
layout wrappers. Permission and question transitions move focus to a usable
target while preserving focus the reader deliberately moved elsewhere.

- Keep focus outlines and takeover focus on visible elements (`be712fd`).

#### Feature

Right-click and keyboard context menus bring existing app commands closer to the
current task. Long usage breakdowns keep their overview and totals visible,
while the prompt grows with its text before scrolling internally.

- Add the app context menu with shared keyboard and command handling
  (`4b2e4ab`).
- Fit long turn breakdowns with scrolling call rows and precise cost labels
  (`979753b`).
- Grow and shrink the prompt input with its content (`19d7ced`).

### 2026-10-19

#### Fix

Toggle buttons now show on/off state without collection-selection marks.
Explicit transcript positioning also takes precedence over queued automatic
follow, so reading intent survives delayed layout work.

- Distinguish enabled toggles from selected list items (`6e333a9`).
- Keep explicit transcript position ahead of queued follow (`6e91329`).

#### Feature

Usage now covers whole sessions and turns, with per-model-call tokens, context,
timing and reported cost. Image attachments, compact sidebar rails and
collapsible file changes make longer sessions easier to use. Optional
server-owned auto-approve replies Allow once for a session and its helpers,
records outcomes, and stays off until explicitly enabled.

- Add full prompt Context to the turn breakdown (`021d911`).
- Break turns down into ordered model calls with activity and time (`29119a7`).
- Place the Auto-approve shield first in the composer footer (`53aca8c`).
- Add persistent session auto-approve and a permission activity journal
  (`4ffc1a8`).
- Show exact commands, targets and scope in permission notification toasts
  (`b62f712`).
- Add image chips, image-only prompts and transcript image viewing (`44e3328`).
- Keep project lights and panel icons available in collapsed rails (`2b1e5d2`).
- Collapse file changes by default with a saved Display preference (`8103ddf`).
- Show whole-session reported cost in the Sessions panel (`e22f011`).
- Add whole-session and turn usage totals with a cost-visibility preference
  (`9aee744`).

#### Test

Viewport checks wait for file changes to finish expanding before measuring code.
This removes a layout race from the test without changing transcript behavior.

- Wait for expanded file changes before viewport setup (`469a88d`).

### 2026-10-18

#### Fix

New sessions resolve their own directory instead of borrowing stale selection
state. Context meters use the reporting model's catalog window, and tool rows
show their actual results with consistent project-relative paths.

- Resolve the new session's directory at its action boundary (`8a0a420`).
- Fill the context meter from each reporting model's known context limit
  (`3194bc5`).
- Share tool-path display between headers, bodies and diffs (`0f0e9c0`).
- Render typed tool results, including read, search, fetch and helper progress
  (`6a345ec`).

#### Feature

Streaming replies gain a quiet progress line, and the composer footer makes
agent and model choices easier to read. Backend-applied choices remain visibly
distinct from explicit overrides, including when native optional fields are
absent.

- Show a glimmer line while a reply streams (`6e8cbb1`).
- Refine composer labels and controls and normalize native optional metadata
  (`43e8f10`).
- Show backend-applied agent, model and variant choices in a muted style
  (`9f079a6`).

### 2026-10-17

#### Fix

Project-row and tab actions now participate in normal layout instead of floating
over other controls. This keeps labels, visit times and actions aligned as
available space changes.

- Put row and tab actions into layout flow (`1438352`).

#### Feature

The composer gains searchable agent, model and variant pickers backed by a
credential-free catalog. Next-prompt choices are kept separately from backend
state, and completed plan/build tool transitions can switch the selected agent.
Questions and approvals take over the composer without losing its draft.

- Switch plan/build agent selection after the corresponding completed tool
  (`05f13b1`).
- Add agent, model and variant composer pickers (`9dc5c8d`).
- Track next-prompt choices, recent models and explicit defaults (`27b594c`).
- Expose model catalogs, agent metadata and recorded message variants
  (`17a4a05`).
- Add stepped question and permission composer takeovers (`a65a112`).

#### Test

Native fixtures can exercise multiple providers and model variants. This adds
integration coverage for catalog and selection behavior without real model
credentials.

- Add fixture-provider and model-variant coverage (`c6e9728`).

### 2026-10-16

#### Fix

Selection marks and overlay surfaces now have shared layout owners, preventing
duplicated borders and floating markers from drifting. Already-mounted session
controls respond to the first capability advertisement while retaining their
input through reconnects.

- Keep selection marks inside the layout of their controls (`d1f3209`).
- Bind selection state and paint through one owner (`9d8bdd0`).
- Share surface, dialog, popover, menu and toast boundaries (`1ee8d10`).
- React to initial session capabilities without remounting input owners
  (`e1fe83b`).

#### Feature

The workspace gains a centred reading lane, grouped work logs and a rounded
composer, alongside quieter task and project chrome. Warm light themes and
status lamps support the new visual direction. A persistent right panel adds a
searchable, task-grouped session tree and helper navigation.

- Centre transcript, diffs and composer and group compact tool/thinking rows
  (`6d04782`).
- Add quieter chrome, corner toggles and shared selection pointers (`c2e5e37`).
- Add warm light palettes, theme selection and gel-style status lamps
  (`6d0995f`).
- Add the reading column, retained drafts and composer takeovers (`566fa81`).
- Add the resizable right panel and project Sessions view (`dcd51fb`).

#### Test

Browser tests now wait for stable pointer targets and completed reply phases
before acting or asserting. Held scripted replies let checks observe busy state
without relying on accidental timing.

- Control reply-phase readiness in scripted browser fixtures (`89960ec`).
- Act and assert only after the owning browser state has settled (`24d32d4`).

### 2026-10-15

#### Fix

Rapid layout edits merge at the saved-state owner, and tab actions no longer
wait for index replication before using a newly created session. Native history
reads are bounded, while malformed events and failed follow-up work stay local
instead of reconnecting unrelated sessions.

- Preserve independent fields during rapid layout changes (`2f50006`).
- Let tab actions resolve authoritative session metadata before the index
  catches up (`1e9a431`).
- Contain native event failures and share one authoritative session index
  (`1ea88f6`).
- Bound message history, revert counts and helper-summary reads (`1b4e384`).

#### Feature

Projects now form a live inbox with unread and visit metadata, saved tasks and
active-session tabs that remain visible when a preview changes. The UI adds
shared typography, attention lights and reduced-colour and animation settings.
These features combine navigation and activity without retaining every session's
transcript.

- Add task, active-session and replaceable preview tabs with helper breadcrumbs
  (`99c4e2a`).
- Add the reusable project inbox workspace (`5bb31d7`).
- Store project, task, seen, finish and template metadata for the inbox
  (`5f0f668`).
- Add the shared visual system and reduced-colour/motion preferences
  (`4607142`).

#### Refactor

Feature-owned contracts replace closed lists for preferences, capabilities,
tools, content parts and RPCs. Storage upgrades are tracked per feature so
smaller consumers can compose only the schemas they need. Existing users keep
their saved data while kit consumers gain clearer extension points.

- Track database migrations independently per feature (`3f49db7`).
- Share typed capability names between backend, transport and UI (`48a15c5`).
- Move preference schemas and theme IDs to feature-owned contributions
  (`046929d`).
- Open typed tool and content-part registries with bounded external previews
  (`6880f35`).
- Derive RPC names, inputs and results from an extensible contract (`3881bc0`).

### 2026-10-14

#### Fix

Compact native inputs no longer inherit full-width text-field sizing. Syntax
highlighting initialization stays inside its worker so worker teardown does not
leave native initialization work behind.

- Keep text-field geometry off checkboxes and other compact inputs (`31d8b5f`).
- Keep native highlighting initialization owned by the worker (`3253ac2`).

#### Feature

The command palette and configurable keymap expose shared actions across the
workspace. Theme selection adds dark, light and system modes with preview, while
notification channels report background completion, errors and input requests
through in-page messages and optional OS notifications or sound.

- Add notification policy, background triggers and selectable channels
  (`c543f9f`).
- Add semantic dark/light themes and theme preview (`3c829e5`).
- Add the command hub, palette and editable keyboard bindings (`e8a0b54`).

#### Refactor

The shipped application now composes reusable kit modules through public entry
points. UI components own their styles and accept registered content and
callbacks, keeping the application separate from reusable rendering behavior.

- Compose the OTK application from selected kit modules (`ce6f97c`).
- Extract reusable UI components, registries and component styles (`231c3be`).

### 2026-10-13

#### Fix

Transcript position survives layout changes without overriding the reader's
intent. Native HTTP and event-stream error reports are reconciled into one
session error presentation instead of competing or stale messages.

- Preserve viewport intent through transcript layout changes (`6f3ef50`).
- Reconcile native HTTP and event-stream errors (`430fe13`).

#### Refactor

Networking, session state, backend capabilities, content conversion and storage
become independently reusable modules. Registered RPC features keep core
transport separate from backend-specific operations, while public package
entries let other applications use the kit without importing OTK's app.

- Extract the framework-free client (`1dac8ef`).
- Compose core services with registered RPC features (`354d610`).
- Extract storage with composable migrations (`56c43f1`).
- Separate harness capabilities from the opencode 1.x implementation
  (`a41edc9`).
- Extract markdown, diff and streaming-content conversion (`cf18f7d`).

#### Build

The Deno workspace establishes public imports for the protocol package. Package
boundary and standalone-consumer checks accompany the move so shared wire
contracts no longer depend on application source paths.

- Establish the Deno workspace and reusable protocol package (`f11a987`).

### 2026-10-12

#### Feature

In-progress replies survive browser reloads with their current text and thinking
content. Message timestamps and live output clocks make streaming and completed
replies easier to distinguish.

- Add message timestamps and a live output clock (`91222a0`).
- Replay in-progress replies across reloads (`c011b0c`).

#### Performance

Code styling is limited to viewport row groups instead of the full transcript.
Shared worker scheduling, bounded caches and source-based selection keep large
code blocks readable without rendering every highlighted span at once.

- Bound styled code work to viewport groups (`f01f499`).

### 2026-10-09

#### Feature

Prompt history can recall earlier opencode inputs without loading attachment
bytes until needed. Slash commands, ranked mentions and shell mode extend what
can be sent from the composer while sharing session admission and error paths.

- Recall prompt history from the read-only opencode database (`0d651d0`).
- Add native slash-command completion and execution (`73650eb`).
- Add file, agent and resource mentions ranked by frequency and recency
  (`b01ac81`).
- Run shell-mode input through the native session (`28214ef`).

### 2026-10-08

#### Feature

The transcript gains syntax highlighting, typed tool output, inline file diffs
and helper-session navigation. Prompt attachments, pasted-text chips and an
in-page editor expand input options, while interactive questions and reverted
turn summaries make backend state visible without adding session-revert
controls.

- Answer interactive single-choice, multiple-choice and free-text questions
  (`25b0b33`).
- Add the in-page prompt editor and pasted-text chips (`7071173`).
- Send structured prompt parts and file attachments (`3afd8e8`).
- Show reverted-turn banners and message details (`01b7b5d`).
- Navigate helper sessions and show their progress (`e491fa9`).
- Render edit, write and patch diffs with diagnostics (`d97e5ab`).
- Render bash, read, search, fetch and other tool output (`5fd5862`).
- Add worker-based Shiki syntax highlighting (`6b658f4`).

### 2026-10-07

#### Fix

Operator config exclusions are limited to the repository root. Nested source
configuration remains visible to Git, formatting and lint checks.

- Scope config ignore and check exclusions to the root operator directory
  (`2869e34`).

#### Feature

OTK starts with layered operator configuration, a local authenticated sidecar
and a live opencode session API. The browser workspace connects multiple
sidecars, streams the selected session and accepts prompts and descendant
permission replies. Saved display preferences add thinking, todo and tool-detail
presentation.

- Add saved display preferences, thinking and todo presentation (`d5f7355`).
- Reply to permission requests from a session and its descendants (`9892a71`).
- Add the multi-sidecar browser session workspace (`9906cdf`).
- Add the opencode session API, live index, streaming and local login/setup
  (`21e1d92`).
- Add layered TOML and environment configuration (`74d8a0a`).

#### Build

The initial browser toolchain uses Solid 2 and Vite with locally bundled assets.
Static serving and browser-test support provide a production build path without
a development server.

- Add the Solid 2 browser toolchain (`df63386`).
