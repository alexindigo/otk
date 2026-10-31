# Changelog

## [0.1.0-beta.2] — 2026-10-31

**Highlights.** Session lists now include all ages of history and carry their
displayed usage and readiness from a background server digest, with no
per-session summary requests. Messages open in pages of ten, preload ahead of
scrolling and stay warm after navigation until their scope cools; cooling keeps
drafts and activity lights. Actions show accepted and pending progress instead
of false timeouts, and reconnects resume the same intent without duplicating its
effect. Deleted sessions keep a struck-through record with their last details
and task membership, rather than vanishing. Shared directory catalogs make
completion local, recall batches attachment reads, and the UI fixes setup,
dropdown spacing, task forms, empty-pane placement and crowded task/breadcrumb
rows while keeping work that needs attention visible (`ea50bf2`, `428f27a`,
`fc871b2`, `a5e9eeb`, `4d68a32`, `d7f229b`, `cc7f2b5`).

**Known gaps.** Whole-transcript copy/export, MCP/LSP/formatter/provider/plugin
dialogs, prompt stash management, a full changes viewer and a quick session
switcher remain missing. Inline diffs, selection/reply Copy, retained browser
drafts and Sessions remain available. There is no automatic continue,
retry-limit or fallback-provider recovery. An uncertain native dispatch stays
pending for reconciliation and is not blindly resent. Stock opencode 1.18.34 can
reject `GET /permission` for a websearch permission missing optional `livecrawl`
metadata; resolve that request in opencode. That specific upstream case has not
been requalified on newer versions. All ten security scanner findings remain
open and unverified; keep OTK bound to localhost (`659704a`, `e171604`;
pre-existing gaps recorded in `91d27da`, `d93f3db`).

**Upgrade.** Stop OTK normally and make a consistent backup of its state and
config, including `otk.db` and any remaining WAL, before installing beta.2.
Beta.1 session references migrate atomically to derived `opcv1-` ids, preserving
tasks/order, preferences/layout, seen/finish marks and approval history. The
separate, rebuildable metadata digest backfills in the background;
**Digesting…** means preparation, not failure. Existing
`harness.type = "opencode1"` still loads with a deprecation message; new
configuration uses `opencode-v1`. Reload the bundled browser for wire protocol
17 and choose legacy bare-ID bookmarks again from Sessions. Downgrading after
migration is unsupported: restore a consistent pre-upgrade backup rather than
editing ids or deleting user state (`6579db9`, `ea50bf2`, `4d68a32`, `f478289`).

See the [install and upgrade instructions](./README.md),
[security findings](./docs/security-findings.md),
[request lifecycle](./docs/request-events.md) and
[packaging recipe](./packaging/README.md).

### 2026-10-31

#### Fix

Crowded projects put only idle, unselected tasks in More; selected and working,
blocked or unseen-finished tasks stay visible, wrapping when necessary. Metadata
bootstrap no longer refreshes a borrowed directory catalog or reacts to another
server's bootstrap, avoiding redundant acquisition during navigation.

- Keep task attention visible through shared measured overflow (`cc7f2b5`).
- Leave borrowed catalog invalidation with its directory owner (`aab086f`).
- Exclude Git metadata from file catalogs and honor native ignore flags.
- Keep permission and question targets current when returning to a warm session.
- Associate failed project-menu actions with their in-row error for assistive
  technology.
- Keep the composer footer steady when Send appears or disappears.

#### Test

Qualification adds full-population directory/task and two-origin attachment
cases, genuine beta.1 upgrade fault boundaries, public reuse and off-source
compiled outcomes. Streaming scale fixtures join native event readiness before
stepping the producer, preserving the original 1,000-frame, source and clipboard
assertions instead of timing out during bootstrap.

- Qualify remaining projections, upgrades, compiled outcomes and PA observations
  at scale (`f478289`).
- Await native readiness before stepped browser streaming (`3535c4c`).

### 2026-10-30

#### Fix

Action failures take precedence over bookkeeping feedback, hidden controls
remain hidden, and pending menus preserve focus deliberately moved by a command.
Urgent reads can preempt optional native acquisition; missing native metadata
stays unknown instead of becoming invented prices, paths or counts. Password
setup signs its browser in, and shared controls, forms, empty panes and overflow
use structural geometry while retaining editors, drafts and visible feedback.

- Keep action feedback ahead of bookkeeping (`e7db764`).
- Respect native hidden controls in shared theme paint (`ffd9bc0`).
- Preserve compact prose edges through transcript windowing (`211cbdb`).
- Use shared operation-notice icons (`096a5f9`).
- Size attention cards to visible content (`9ba09c5`).
- Let urgent reads preempt and join transient native I/O (`b96c276`).
- Preserve command-directed focus through pending feedback (`32adc90`).
- Preserve native metadata, server path semantics and shared feature policy
  (`b634aee`).
- Authenticate the setup browser after password configuration (`ef69f48`).
- Share control slots, auth/form/dialog geometry, pane centring and stable
  breadcrumb overflow (`d7f229b`).

#### Feature

All shipped actions and reads use the accepted/pending/result lifecycle,
including bootstrap HTTP operations and uncertain native effects. Shared
directory catalogs publish complete values and keyed inbox changes, so typing
and agent cycling filter locally rather than making discovery calls. Global
recall and attachment batches read provider data on demand without persisting
their content in OTK.

- Activate request events for every action and read (`a5e9eeb`).
- Add shared directory-owned catalog services and live pending questions
  (`27fb44d`).
- Batch provider-backed global recall and attachment preparation (`803735d`).
- Publish keyed inbox/frecency updates, complete catalog chunks and
  origin-batched attachment requests under protocol 17 (`4d68a32`).

#### Refactor

Task and identity validation use set-oriented reads, and committed metadata
changes update only their affected keys. Attention, notification comparisons and
Activity share identity-based projections; hidden Activity releases its reads.
Pending and failure surfaces share presentation and lifetime owners instead of
reconstructing forms or duplicating feedback.

- Share pending, failure and operation-attention surfaces (`28c66b5`).
- Query tasks and authoritative identities by set (`cd2c18f`).
- Maintain attention, notifications, Activity and retained tabs by identity;
  serialize common broadcasts once (`05bb27d`).

#### Performance

Streaming Markdown retains one producer-owned parsed revision across flush,
snapshot, replay and completion. Optional clock and preview enrichment no longer
holds ordered essential delivery; correctness for unstable suffixes and late
references is retained without claiming universal linear parsing.

- Retain producer parse state and isolate optional enrichment (`35d11b5`).

#### Test

Request-recovery coverage observes real native effects, restart/reconnect and
pending state at scale. Existing fixtures follow accepted-result contracts,
actual available controls, virtualized targets and current owner lifetimes;
their source, persistence, payload and accessibility assertions remain in place.

- Track retained source across viewport changes (`b881bfb`).
- Hit-test virtualized context targets (`3c44dd9`).
- Align timestamp expectations with composed schemas (`1a1f694`).
- Keep consumer-held scripted provider streams alive (`fb1b813`).
- Follow request-feedback and surface lifetimes (`7291760`).
- Qualify request recovery, restart and native effects at scale (`e171604`).
- Follow inbox accepted/result and structured-failure contracts (`c97d7b1`).
- Measure empty and sendable composer controls and safe feedback (`f923ee6`).
- Distinguish definite recall failure from reconnecting work (`4853684`).
- Align integration fixtures with resumable request lifetimes (`338ebe4`).
- Observe visible Activity feedback and safe failure copy (`2777124`).
- Account for the tasks index migration (`4db7c3d`).
- Exercise available composer actions with genuine sendable input (`414e9e3`).
- Join the local accessible approval-policy paint (`6c9768b`).
- Acquire reloaded tool-path history through its cursor owner (`6486c48`).
- Join optional directory colour revalidation before exact assertions
  (`81898c0`).
- Expect Send to be absent while attachments load (`07a5edc`).

### 2026-10-29

#### Fix

Digest work yields execution during readiness, credit and I/O waits, allowing
urgent reads between bounded chunks. Metadata bootstrap completion is separate
from transcript invalidation, preserving current pages while actual reconnect,
disposal and revert boundaries still replace stale authority. Initial pages,
helper demand and publication progress survive intervening metadata changes.

- Yield digest execution while waiting for readiness (`482c734`).
- Separate bootstrap completion from versioned transcript invalidation
  (`ea02621`).
- Preserve initial pages across metadata updates (`913c1b8`).
- Resume helper demand after catalog discovery (`db65234`).
- Preserve digest publication liveness under priority pressure (`31ff85a`).

#### Feature

Durable metadata receipts give local mutations an atomic completion record and
prevent same-intent retries from duplicating effects. Resumable execution adds
acceptance, correlated progress/results, read release and native-dispatch
fences; unconfirmed effects remain reconciling rather than being dispatched
again.

- Add durable request receipts and composable store writes (`5f1999c`).
- Add resumable request execution and client tracking (`659704a`).

#### Test

Scale qualification measures message paging, cooling, serving lag and real
browser outcomes with synthetic populations and off-source binaries. Browser
drivers follow native scrolling, measured windows, progressing backfill and
terminal ledgers rather than stale whole-history or timing assumptions; these
changes strengthen verification without adding product features.

- Qualify message paging and cooling at scale (`5b55f23`).
- Exercise lazy tool bodies through their disclosures (`89d67ad`).
- Qualify transcript release at scope cooling (`d91571f`).
- Isolate usage proofs from viewport hydration (`9de5611`).
- Hold message pages in creation-readiness probes (`f99186e`).
- Follow transcript windows in browser probes (`45a7da8`).
- Distinguish cancelled reads in scale observations (`fbd8f16`).
- Drive list probes through native scrolling (`1e0cd3c`).
- Await progressing scale backfill (`2e45f5f`).
- Qualify bounded scope warming in scale probes (`7c73aee`).
- Reveal rollback targets through native scrolling (`48833e4`).
- Stabilize complete-turn ledger probes (`24c7966`).
- Await terminal ledgers in compiled probes (`d66c31e`).
- Retain owned Timeline reveals in browser probes (`88c0954`).
- Wait for progressing scale digestion (`9b70b7c`).
- Recognize atomic layout write scopes in architecture checks (`afbe89e`).

### 2026-10-28

#### Fix

Lost stream seeds recover through bounded, generation-fenced replacement
checkpoints instead of polling on each delta; unaligned source stays visibly
refreshing until authoritative completion. Provider contexts expose ports rather
than render props, project observation is idempotent, and connected catalog
reads follow their actual owners.

- Recover missing stream seeds with versioned snapshots (`9e31ca4`).
- Isolate provider ports from render props (`7702af7`).
- Make project observation idempotent and single-owned (`ce56f6f`).
- Scope connected catalog reads to their owners (`2610cc2`).

#### Feature

Message bodies share scope-temperature lifetimes: recent navigation stays warm,
attention preloads without marking seen, and cooling releases source while
retaining drafts and supervision metadata. Helper progress comes from the shared
digest without blocking parent pages. Transcripts, long reply/code/diff content
and Timeline render measured windows, while collapsed bodies release expensive
rendering and highlight state.

- Retain message bodies by scope temperature (`fc871b2`).
- Digest helper progress without blocking pages (`8f06b1b`).
- Window transcripts and deactivate folded bodies (`49f7008`).

#### Refactor

Live transcript and usage changes address keyed messages, parts, replies and
calls instead of regrouping acquired history. Opened breakdowns acquire only
their complete turn, preserve unknown categories, and Copy reply lazily acquires
missing source through the canonical body owner.

- Update transcript and usage projections incrementally (`8728c5a`).

#### Test

Pointer drivers distinguish browser-native input from application viewport
ownership and observe their actual target before interaction. This preserves
native input behavior without adding product scrolling shortcuts.

- Respect viewport ownership during pointer input (`d096f4d`).

### 2026-10-27

#### Feature

A worker-backed digest supplies rebuildable session/turn summaries, explicit
readiness and retained deletion details without copying transcripts into OTK.
The complete session index carries the values rows and footers display, removing
per-session usage fetches. Active-project lists are windowed, and transcript
bodies begin with ten-message native cursor pages carrying the latest prompt's
context independently of the loaded page.

- Add worker-backed session digest services (`ea50bf2`).
- Serve complete session summaries and deleted-session details (`428f27a`).
- Window active session lists while retaining interaction identities
  (`39f06ed`).
- Page transcripts with opaque native cursors and aligned clocks (`a67291e`).

#### Test

Synthetic native-scale qualification covers complete indexes, nullable usage,
retained tombstones, responsive consumers and off-source compiled startup.
Independent expected manifests and serving/browser observations establish
outcomes rather than inferring them from a successful launch.

- Qualify session digests at scale (`aff644b`).

### 2026-10-26

#### Breaking

The adapter and package are renamed to `opencode-v1` and
`@otk/harness-opencode-v1`, and session references become derived
`opcv1-<native id>` values across native boundaries, storage and browser routes.
The atomic reference upgrade preserves user metadata; the old configuration
spelling remains accepted with deprecation, but old bare-ID links require a new
selection and post-migration downgrade requires a pre-upgrade backup.

- Qualify opencode-v1 session identities and migrate beta.1 references
  (`6579db9`).

#### Fix

Concurrent OTK openers install their SQLite busy wait before selecting WAL mode.
This lets startup contenders wait for the shared database instead of failing
before the atomic session-reference upgrade can begin.

- Install the busy timeout before WAL selection (`6579db9`).

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
