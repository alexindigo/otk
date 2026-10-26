# @otk/client

Framework-free OTK networking, RPC and state. Production code depends only on
`@otk/protocol`. No Solid runtime is required. LGPL-3.0-only.

## Public API

Import only `@otk/client` (the `mod.ts` entry).

| #  | API                                                                                        | Purpose                                                                                                              |
| -- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1  | `SidecarConnection`, `Rpc`                                                                 | Auth discovery/login/setup, hello/welcome, heartbeat, reconnect/backoff, subscriptions, cancellable size-bounded RPC |
| 2  | `apiBase`, `normalizeBase`, `request`                                                      | Prefix-aware HTTP API and cookie-based browser requests                                                              |
| 3  | `createIndex`, `sessionKey`, `projectGroups`, `liveSessionInfo`                            | Multi-connection index merging with revision-gap detection                                                           |
| 4  | `createSession`, `emptyContent`, `reduce`, `queuedMessages`                                | Snapshot/live replay, paging, stream versions, error revisions and visible-output clocks                             |
| 5  | `oldestPermission`, `belongsToSession`, `isAttentionOp`                                    | Permission/question family ownership and ordering                                                                    |
| 6  | `loadHistory`, `mergeHistory`, `sameHistory`, `sameParts`                                  | Partial-success cross-connection history with attachment ownership                                                   |
| 7  | `createNavigation`, `route`, `hashFor`                                                     | Selection and accepted-history traversal with dirty-state callbacks                                                  |
| 8  | `createCurrentClient`                                                                      | Invocation-time selected connection/RPC context and session-scoped calls                                             |
| 9  | `createState`, `StateFactory`, `StateStore`                                                | Synchronous observable state or an injected framework binding                                                        |
| 10 | `createSidecars`, `readSidecars`, `LOCAL_SIDECAR`                                          | Connection collection and persisted browser sources                                                                  |
| 11 | `createServerResources`, `ServerResources`, `FrameObserver`                                | Per-server inbox, approval and project-tab resources, live projections and ordered frame observers                   |
| 12 | `createSessionActions`, `SessionActions`, `sessionFamily`, `familyTask`, `familySelection` | Shared session-target operations and pure family projections                                                         |
| 13 | `createInputGuard`, `InputGuard`                                                           | Owner-current draft release and dirty-input permission checks                                                        |
| 14 | `createShellNavigation`, `ShellNavigation`, `shellTitle`                                   | Guarded routes, creation revisions, project/settings state and seen/visit bookkeeping                                |

Models expose `state` and `subscribe(listener)`; subscriptions return an
unsubscribe function and notify after updates, without an initial notification.
Treat state as read-only outside model methods. A UI binding can supply a
`StateFactory` implementing draft updates and reconciliation. The application's
thin Solid binding retains granular updates at the UI boundary.

Session snapshots publish essential session/message data independently of
optional attention and sibling reads. Optional failures retain last-good data
and expose diagnostics. Live attention changes replay over their own resource
snapshot. Replacement fetches retain the live-operation buffer; failure applies
it to a last-good transcript, or retains it for retry when no baseline exists.
`state.continuity` distinguishes `loading`, `ready` and recoverable `missing`
baselines. Superseding a generation retires its paging flag. Late `agent.colors`
operations decorate the existing transcript without retaining another
collection.

`rpc.call(method, params, signal?)` derives its input and result types from
`@otk/protocol`'s declaration-mergeable `RpcMethods` interface. Callers do not
supply result type arguments. `createCurrentClient().call` uses the same
contract with `sessionID` omitted from inputs and injected at invocation time.
Feature-owned module augmentations are shared by server and client consumers.

Browser connections use cookies. Supply an explicit base URL outside the
browser; `ConnectionOptions.socket` allows a native transport with Origin and
the operator's authenticated cookie. `ConnectionOptions.api` or
`apiBase(baseUrl, assetUrl)` permits explicit asset-prefix resolution. No server
authentication or origin check is bypassed. `createSidecars` additionally
accepts storage and local connection options; non-browser callers usually
compose one `SidecarConnection` directly. Navigation accepts an injected
history/location environment, so its accepted-route model is usable without
browser globals.

Legacy welcome frames retain their supported RPC families; explicit capability
lists are authoritative. Connection metadata remains mounted across reconnects,
while `supports` reports live availability. Session generations, aborted
requests, buffered ops, error and stream revisions and finished clocks retain
their existing semantics. `createDrafts(factory?)` owns browser-lifetime,
server/session-keyed unsent `Draft` values. `writer(key)` binds updates to one
session and returns invocation-current values even before a framework paints.
Late uploads and sends update only their originating draft; a newer edit is
never cleared by completion of an older submission. Permission/question input
remains owned by its UI feature and protected by navigation confirmation.

`Chip.start`/`end` are paired optional text coordinates: present for inline
tokens, absent for independent attachments. Independent image chips are not
textarea placeholders and survive text/editor replacement. Their bytes stay in
the session-bound draft and late upload updates retain the existing writer
identity checks; removing a chip prevents a late completion from restoring it.

`effectiveSelection(draft, { context, agents, catalog })` is the shared pure
next-prompt projection for display and every submission path. Each field reports
its backend-applied value, source (`explicit`, `restored`, `configured`,
`default`, `absent`) and `userChosen` ownership (`explicit`/`restored` only);
model metadata includes display/provider names, advertised variants and an
unavailable flag without replacing a missing model. Inputs use the last loaded
user message and primary agents in configured-default order. Context is never
copied into the draft, so unsent explicit choices win. An absent catalog means
unknown availability; only a loaded catalog can establish that a model is
unavailable. Unknown catalog metadata also preserves a restored/explicit
variant; validation and model-choice clearing require loaded negative
membership. The projection's `applies` and `input` describe mode applicability
and exact wire choices: shell omits variant while retaining the draft's
normal-mode choice.

`chooseAgent`, `chooseModel` and `chooseVariant` return next drafts for the
existing session-keyed writer. Choosing an agent applies its configured choices;
choosing a model drops an unsupported explicit variant. Invalid variants omit
the input rather than restoring an older user choice. A missing draft variant
inherits; `chooseVariant(draft, undefined, context)` creates an own
`variant: undefined` property for explicit Default, which suppresses restored
input without a wire sentinel. When the backend will apply a valid configured
variant for the agent's own effective model, `variant.value` reports it as
configured / not user-chosen while `input.variant` stays absent. `variantChoice`
retains the selected Default row and cycle position independently of that
applied value. Invalid choices also omit input and therefore project that same
native fallback when valid. Preserve the own-property distinction when spreading
drafts. `clearDraft` clears submitted content but retains all explicit choices,
including Default; callers retain the existing submitted-draft identity guard
around it.

`replaceDraftContent(draft, content)` changes input, chips and mode while
retaining the current draft's choices, including absent versus own-undefined
Default, and releasing its editor. History, whole-prompt editor saves and
`clearDraft` use this same boundary. The plain `draft-content` transforms also
own inline/independent chip edits, serialization and paste labels; no browser or
framework is required.

`createPromptHistory({available, load, change, fail})` owns a per-prompt recall
queue and cursor. It reads the session-bound writer's invocation-current draft,
serializes consecutive intents, preserves current choices through recalled
content and return to empty, and rejects replacement after newer edits. Reset
and disposal retire pending results/errors. `recall()` joins its actual async
continuation; caret placement is passed to the injected input port. Native keys
and focus stay with the UI adapter. `historyDraft` and `PromptHistory` expose
the metadata-only projection and cursor for independent consumers.

`recordRecentModel(recent, sentModel)` returns a deduplicated most-recent-first
list (max 10) after a successful send, using the submission's captured model.
`toggleFavouriteModel(favourites, model)` toggles exact provider/model pairs,
putting additions first (max 50; a full list keeps existing favourites). These
helpers own no persistence: callers save `models.recent` and `models.favourite`
through the existing host-sidecar preferences RPC.

`modelGroups(catalog, favourites, recent, current)` supplies retrieval groups
for model pickers: favourites, recent minus favourites, then providers with
models newest first. Deprecated models appear only when
favourite/recent/current; unavailable references never invent catalog entries.
`modelKey` preserves exact provider/model pair identity, including slashes in
IDs. Neither helper owns UI, networking or persistence.

`createComposerSelection({draft, change, context, connection, load, prefs, factory})`
owns composer catalogs and intents without a UI framework. Its StateFactory
notification uses the same revision pattern as `createDrafts`: owner-current
snapshots expose capability/loading/error/last-good data even before a framework
publishes its revision. `connect()` keys in-flight work to the welcomed
connection identity, never joining or applying older work; `ready()` follows
invalidation and waits for current work. Refresh errors retain good data and do
not repeatedly retry on submission. `choose*`, serialized `cycleAgent`,
`cycleVariant`, serialized `toggleFavourite` and `recordSent` share the existing
pure helpers. `groups()` returns refs, keys, favourite flags and subtitles (only
favourite/recent groups). Dispose ends catalog publication and deferred draft
intents. Captured successful normal sends can still record recency after view
replacement.

`createModelCatalog({connection, load, factory?})` owns one session/directory's
model metadata: one in-flight request, invocation-current
loading/error/last-good state, connection-generation invalidation, explicit
refresh/retry and readiness that follows the current connection. The selected
session exposes this owner as `createSession().models`; selection changes
dispose it. The optional fourth `createSession` argument injects connection
identity/advertised availability. Composer consumers pass it as `modelCatalog`
to `createComposerSelection` and borrow the same state and work as the meter.
Composer disposal releases its subscription, not the session's resource.
Standalone composers create the same resource locally when none is supplied. No
catalog is copied into another store.

Agent and model catalogs share one framework-free resource lifecycle. It
reserves in-flight identity before publishing loading, aborts retired
generations, retains last-good data and lets readiness follow replacement work.
Composer load ports receive the resource's cancellation signal; UI adapters
forward it to typed RPC.

`createSession().onToolCompleted(selection, listener)` observes completed tool
parts only from the selected session's live stream. Initial/refetch snapshots
and older pages establish a silent baseline; completed IDs stay consumed until
the session closes. Late subscribers can receive completions observed during
initial loading, using the existing transcript rather than a second part store.
`createComposerSelection` accepts this optional source and maps completed
external `plan_exit` / `plan_enter` parts to its ordinary
`chooseAgent("build"/"plan")` intent. Primary-agent readiness precedes the
intent, missing agents do nothing, and disposal cancels pending switches.
Historical completion never seeds a draft.

Sidecar state exposes `connectionVersion`, incremented for every welcome,
including reconnects, so consumers can identify the current connection even if
reactive batching coalesces a disconnected interval.

`createPromptCompletion({sources, fail, factory?})` owns generic per-prompt
completion arbitration, query generations, options and choice transitions. Feed
`update` the current input/mode/caret, connection availability and chip ranges;
the first matching source wins outside inline chips in normal mode. Query
replacement, close and disposal retire previous results and errors. Directory
expansion retains completion; ordinary selection closes it. Like drafts and
composer selection, invocation-current data is independent of deferred framework
publication. Sources retain their own feature-specific loading and selection
ports; the owner requires no browser, Solid or ranking dependency.

`createQuestionForm(request, factory?)` owns the framework-free question steps,
single/multiple option picks and typed own answers. `answers()` derives the wire
reply from that state; choosing a single option retains unselected typed text.
The request-keyed form survives view replacement until `forgetQuestionForm(id)`
after a successful reply. The UI owns focus, collapse and reply progress only.

`replyMetadata(messages)` combines backend steps for the same session/user reply
using the same grouping owner as `replyMessages(messages)`. The latter supplies
the transcript with stable first-step keys, so expanding a work log or tool is
preserved as later backend steps stream in. Metadata is projected into one final
metadata record, retaining the reply's start, final clock and interrupted state.
No session content is duplicated into a second store; the projection also
combines source parts for whole-reply copying. No session content is stored
outside the currently loaded transcript.

`timelinePrompts(messages, busy?)` projects that same loaded transcript into
chronological prompt identities, creation clocks, shared queued flags and
borrowed source parts. It retains no content or paging state; consumers present
parts through their own registry and page through the original session owner.

`replyMessages(messages, busy?)` additionally projects generic pending user
requests from the current/queued turn and unfinished grouped replies. A later
request cannot revive completed history, and idle retires pending state. Views
forward that projection to part renderers; they do not infer native part kinds
or retain another transcript store.

`createSession().usage` is the framework-free shared SessionUsageOwner. Its
target-keyed load/get API supplies full session and user-turn metadata from the
optional usage capability, independently of transcript pages. Public
`createSessionUsage(connection, factory?)` supports smaller compositions. Reads
coalesce; live assistant headers/removals replace keyed baselines through the
protocol UsageLedger, including events buffered during a snapshot. Duplicate
headers and snapshots cannot add a step twice; tool-label upserts/removals merge
through that same ledger and header-only updates preserve them. Completed
baselines reject stale unfinished headers. Reconnect/resync rejects old reads;
observed index changes refresh cached targets. stop releases all
metadata/requests. No content parts are retained, only call clocks and existing
tool labels; missing capability never causes a partial-page estimate. The ledger
supplies the complete turn's first start/last end independently of transcript
pages.

Mounted usage consumers hold `retain(target)` leases; the returned release is
idempotent and bound to that exact resource. The selected transcript owns one
lease; the Sessions panel binds `usage.scope().set(targets)` and disposes its
scope on unmount. Shared targets coalesce work until the last lease releases,
which aborts reads and removes both ledger and published snapshot. Explicit
index removals and `removeServer(id)` invalidate targets, including held reads.
One-shot load/get consumers retain at most 32 unleased targets in
least-recently-loaded order; leased targets are never evicted by that reuse
cache. `stop()` ends the owner and cannot be undone by late frame delivery or
loading.

`priceUsage(total, catalog?)` prices the owner's exact per-model summaries, with
reasoning at the output rate. Unknown prices leave category costs absent and
known zero prices remain zero. Backend-reported totals stay authoritative,
independent of catalog estimates. `usageTokens` supplies compact token labels;
`usageCost` owns one USD presentation rule for every consumer: two decimal
places, `<$0.01` for positive sub-cent amounts, and `$0.00` only for actual
zero. Its `"exact"` mode preserves the reported amount for title-free accessible
detail, including arbitrarily small nonzero values. `turnUsage` projects ordered
per-call rows with exact counts, reported costs, activity labels and clocks plus
the ledger's one turn range. The shared priced projection also supplies
`context`: New input plus cache read and write, for each call and the total. It
is a prompt subtotal, not another charged token category; `tokens` still
includes each of the five categories once. Detail Total cells retain category
prices. U5 can load/get other targets through the same owner and read
value.total.cost without another aggregation path.

The turn projection also supplies `contextPeak`, the largest individual prompt
including both caches, independently of the final prompt or sum. Turn detail
uses this same value for its overview and per-call visual comparison scale.

`countLabel(count, singular, plural?, display?)` is the shared noun-count
formatter for views and framework-free notification channels. The numeric count
owns singular/plural even when optional display text is compact or localised.
The UI's existing public countLabel export delegates to this same owner.

## Plain Deno example

[`example.ts`](./example.ts) connects to the main OTK core and prints reduced
content after snapshot or live updates:

```sh
deno run --allow-net packages/client/example.ts http://127.0.0.1:1502 SESSION_ID
```

Use an already configured `none`-auth core for this minimal example.
Authenticated deployments should inject their authenticated native transport.
The standalone consumer in `tests/reuse/client-consumer.ts` imports only
`@otk/client`, sends a prompt through the real application core, and observes
reduced streaming content and a finished assistant clock. Application
integration/e2e tests stay at root; client units live in `tests/`. Run project
checks in the assigned OTK VM.

## Inbox metadata and tabs

`createInputGuard({drafts, key, confirm})` owns dirty-input marks and
confirmation policy. Release reads the invocation-current draft through
`Drafts.current(key)` (non-creating and independent of framework publication)
and clears only an accepted editor, preserving the prompt and choices;
navigation clears attention marks only when the session identity changes.
`permit` checks a single input owner without consuming its dirty state.
`release({draft: "kept" | "dropped", keys?})` states whether released stored
drafts survive. Ordinary navigation defaults to kept. Dropping unsent content
asks first, including background/family drafts named by keys; consent does not
consume those drafts before the mutation succeeds. `Drafts.drop(key)` removes
committed deletions and retires captured writers, so late uploads/sends cannot
resurrect their deleted draft lifetime.

`createShellNavigation({resources, actions, guard, drafts, session, presence,
environment?, factory?})`
owns project/settings/error state, accepted routing, guarded preview/pin/open,
creation revisions and seen/visit bookkeeping. It wraps the existing
injected-history navigation owner. Later intents supersede pending creation
navigation and errors, while captured task actions retain their server and
project. View observations record first visits after content readiness;
subsequent finish observations mark seen only while focused and visible. Browser
confirmation, history and presence remain injectable. `shellTitle` is the pure
session/project/application title projection.

Project switches restore the last accepted session through this same navigation
owner. Locations live in the existing host-sidecar `shellLayout` preference;
`layout.location` merges one server/directory intent at the persistence owner,
so concurrent project visits cannot overwrite one another. Pending saves bridge
immediate switches; preference broadcasts own the saved snapshot. Current task
membership resolves the restored session's tab, including helper ancestry.
Missing or closed locations fall back to the ordinary first-root selection.

`close(target?)` captures the target's server/project and removes only explicit
task membership through `TaskActions.remove`. It releases the tab view without
deleting backend metadata, returns helpers to their immediate parent, and keeps
later navigation authoritative across an asynchronous mutation. Current input
uses the same release guard; mandatory activity uses an injected confirmation.
`ClientTabs.close` clears only preview/selection and remembered member state, so
the ordinary activity projection still retains every mandatory phantom.
`remove(target)` shares that same captured view-release owner, declares that the
family's drafts will be dropped, then invokes SessionActions.remove. Only a
successful native deletion drops those drafts and releases the affected view.
Cancellation or failure preserves the draft; later navigation remains
authoritative. Native deletion events, rather than a second client task
mutation, remove membership.

`createSessionActions({resources, session, current})` owns session-target
directory resolution (index, matching selected info, then authoritative lookup),
non-submitting actions and the shared submission port. Prompts resolve the
invocation-current target before admission and preserve each history
attachment's server ownership. Abort and attention replies use `act` without tab
promotion. Its live info/key projections are framework-free; memoisation stays
with the UI.

SessionActions `rename(target, title)` captures the target's server and performs
the typed mutation inside `act`, preserving directory and successful-action
bookkeeping without promoting a task. `createSessionRename` owns one
identity-and-origin-scoped editor (`tab`, `chip` or `row`),
trimmed/empty/unchanged admission, pending state and retryable errors.
Replacement editors retire late results. With a title lookup, `observe()` keeps
the typed editor mounted until the authoritative index catches up to a
successful rename. `remove(target)` captures the same server identity, aborts a
working session before the typed delete RPC and records one successful `act`
without promotion.

`fork(target, through?)` captures the same target and `act` bookkeeping. The
navigation owner's fork intent preserves stored drafts, creates a
browser-lifetime `createForkNotes` entry and opens the result through guarded
navigation; newer navigation retires its late routing. The common submission
port wraps successful normal, shell and native-command sends to dismiss that
session's note, retaining it after a rejected submission. Reply projections
expose `lastID` alongside their stable first-step identity so inclusive forks
retain the whole grouped reply.

`compact(target, model)` captures the session/server and explicit next-prompt
model through the same non-submitting `act` owner, without task promotion.

`revert(target, messageID)` and `restore(target)` use the same captured-target
`act` owner. `createSessionRevert({session, actions, drafts, status, factory?})`
serializes selected-session revert/restore/undo/redo intents, exposes
pending/error and projects the authoritative `content.revert` into the composer
strip. Selection changes retire late results and errors; no RPC result
optimistically mutates session content. `dispose` releases its subscription. No
file-overlap confirmation is added.

Undo targets the last visible prompt, interrupts a working captured session,
then waits at most ten seconds for authoritative idle before reverting. Its
history refill preserves prompt choices and replaces only empty or identical
owner-written content. Redo unreverts and clears only the identical
owner-written draft; newer text, attachments and unsaved editors survive.
Captured draft writers cannot resurrect a dropped lifetime, and
selection/disposal retire pending waits and draft effects. `abort(target?)`
accepts a captured target for that same owner.

Intent completion waits for authoritative transcript publication, including an
in-flight resync. A rollback must remove its boundary prompt; restoring must
publish restored message identities. Only then can another intent select its
target and draft effects run. Publication has the ordinary 30-second RPC-sized
bound; selection/disposal cancels it. RPC admission never substitutes for the
consumer seeing the result.

The hierarchy owner also exports `sessionFamily`, `familyTask` and
`familySelection`. Shell's location projection intentionally matches only the
requested ID and the selected root without filtering directories; its task
membership predicate uses full ancestry and the indexed directory. These remain
distinct call shapes of the same pure task projection.

`createServerResources({sidecars, index, factory?})` constructs its sidecar
collection through the injected receiver factory and owns lazily cached inbox,
approval and project-tab models. Its getters read live state; callers keep
framework memoisation at their binding boundary. `tabSnapshot(project)` supplies
the detached nested reads for a tracking scope; `syncTabs` applies them and
previews the selected project session only when needed. Tabs retain both
owner-current inputs and authoritative session lookup for readiness.

Frames reduce approvals, index and inbox before ordered observers run. An index
gap requests a resnapshot and reaches observers with `accepted=false`, so
notification consumers can skip it while session consumers retain delivery.
Removal clears the index, notifies observers, releases the inbox, approval and
all project-tab caches for that server, then removes its connection. Guarded
navigation detaches a selected server before removal even when its project is
still loading. Tab disposal retires pending promotion publication and prevents
later admission. `stop()` releases all caches before sidecars and ignores late
frames; stopped owners cannot create replacement resources. Server-scoped task
actions, live capability and history-source projections, labelled projects and
the local layout/preference RPC ports share this owner.

`createInbox(rpc, factory?, report?)` receives connection-local `inbox` frames,
including the snapshot sent on every hello. `openProject`, `openSession` and
`act` reset the server-owned visit clock; opening a session also records its
seen timestamp. Wrap sends, approvals, answers and interrupts in
`act(directory, callback)`. Successful actions request activation through the
same visit bookkeeping port; opening/viewing never requests activation. Session
creation is tracked by the server's creation registration. For submissions,
`createSessionSubmission({sessionID, directory, inbox, tabs})` is the shared
session-bound admission port: it resolves the captured project's directory,
enters the existing tab `send` promotion, then runs the mode-specific callback
through inbox `act`. Normal prompts, shell commands and native commands
(including palette execution) use this same port. Promotion failure prevents
native admission; action failure propagates without recording a successful
visit. Concurrent submissions reuse the tab owner's promotion, independently of
metadata broadcast delivery. Approvals, answers and interrupts use `act`
directly, without promoting a session merely for responding to it.
`promote(session)` creates a title-named task with its initial session
atomically. These are UI-independent ports: callers own navigation guards,
action callbacks and failure presentation.

After a successful action, a failed `projects.visit` is a separate bookkeeping
diagnostic: `act` still returns the exact action result, so an admitted send or
reply cannot look unsent. The injected `report` port (console diagnostics by
default) owns that failure; `createServerResources` forwards its optional
`error` port and the browser binding routes it to existing navigation feedback.
Reporter failure is diagnosed separately and cannot change the accepted action
result.

`readSidecars(storage, diagnostic?)` parses the saved envelope once and
validates each remote entry independently. Bad entries, duplicate IDs/URLs and
invalid URLs are diagnosed while valid neighbours survive. A corrupt envelope
yields only the implicit local server and a diagnostic. Reading never rewrites
saved data; `createSidecars` accepts the same diagnostic port in its options.

Every connection attempt owns discovery, socket callbacks, RPCs and retry timer.
Replacing an attempt immediately retires its socket and availability; a captured
old callback cannot send or publish into the replacement. Collection additions
share one pending operation per normalized URL. Stop cancels discovery and
fences late installation; persisted specs are owner-current even with a deferred
state factory. Re-adding a removed server creates a fresh connection lifetime.

`projectHash` / `projectRoute` provide project-only URLs for empty projects,
separate from session URLs; pass both through the same guarded navigation owner.
`projectName` names a path without embedding server identity. Consumers keep
server IDs alongside shared projections and add machine labels for collisions.
`createProjectPicker` owns directory discovery and captured project-add intents.
Its connection input includes sidecar identity, welcome version and readiness;
scan state is invocation-current through the usual revision factory. Replaced
connections cancel reads and clear their projection, `ready()` follows current
work, and explicit refresh retries a settled failure. Add captures its server
and trimmed path, shares identical pending submissions, and forwards the
canonical directory to injected open/close ports only while the picker remains
alive. Disposal retires scan publication and add navigation without undoing a
committed server mutation. Native inputs and presentation belong to the UI
adapter. `registerPreferenceCommands` is the framework-free command contribution
owner; its menu/command metadata still derives from the protocol preference
registry. When creation returns a session ID, the optional `openSession` output
receives that exact captured session before close; it never waits for index
replication.

`inboxStatus`, `rollup`, `unread`, `inboxProjects`, `visitTime` and `ageing` are
the shared pure projections for column, rail and badges. Supply the connection's
index entries, its metadata and an explicit current time. Ageing defaults to
2h/8h/24h and accepts the validated `projectAgeing` preference (milliseconds).
Keep each server's inputs separate when merging the resulting project rows.
`inboxProjects` is also the catalog projection: tracked membership wins over
index-only directories, which win over template-only discovery. Its `source`
distinguishes these rows; discovery sorts index-first by newest activity, then
name, without backend queries. Template-only rows have no visit clock or light.
`INBOX_STATUS_PRIORITY` owns aggregate light priority: needs you, finished but
unseen, working, idle. Project and task lights both use `rollup`; presentation
does not rank states. Task order, phantom index order and discovery recency/name
order remain independent of light priority.

`createTabs(inbox.promote, factory?)` takes
`update({directory, entries, inbox})` and exposes task, mandatory phantom and
single-preview tabs. `select`, `preview`, `pin` (also the double-click action)
and `send(sessionID, callback)` own tab transitions. Required activity tabs
never disappear when a preview is replaced; an idle/seen selected phantom
remains until selection leaves. Inputs remain owned by their index/metadata
models, and tabs never delete sessions. Concurrent pins share promotion; late
completion cannot steal a newer selection.

An optional third `sources` argument supplies `input()` (owner-current tab
inputs) and `session(sessionID)` (authoritative identity/title/directory
lookup). Tab commands read current inputs before validation, so a deferred
rendering effect cannot reject a newly available tab. Pin/send resolve missing
session metadata without waiting for index replication; concurrent calls share
resolution and promotion, and validate the invocation's project and session
identity before acting. `TabSession` contains only identity, directory and
title: promotion never requires a replicated status/attention row. `update`
remains the view-invalidation port and the input port for consumers that update
synchronously.

Tab state also exposes its selected `sessionID` and an input `revision` for
reactive bindings. `sessionFor(taskID)` resolves the remembered member/helper or
first member; `select(selection, sessionID?)` keeps that session inside its
task. `createTaskActions(rpc, directory)` captures server/project ownership for
task editors before asynchronous interaction. `contextMeter(messages, catalog?)`
uses the latest reported assistant token footprint (including reasoning and
caches). Charged costs belong exclusively to the usage owner. When the catalog
reports a finite positive context limit for that exact assistant provider/model,
it also supplies the limit and a clamped fill fraction; unknown windows stay
unknown. The session's shared catalog loads independently of the transcript and
rejects stale results; refresh errors retain last good metadata. The meter binds
the owner's whole-session reported cost directly, independently of its
latest-context footprint. `taskBreadcrumbs(task, entries, selected)` preserves
explicit membership order, expands the selected helper path and prevents cycles
or duplicate grouped helpers. Helper URLs retain their owning task; removing
membership preserves the viewed session as an ungrouped tab rather than leaving
transcript and task inconsistent.

Task actions `add(task, sessionID)` and `remove(task, sessionID)` need only the
task's ID. They send `tasks.addSession` / `tasks.removeSession` intents;
captured membership never crosses this mutation boundary. The server applies
each intent to current persisted membership, so concurrent additions and
unrelated removals survive delayed metadata delivery and session creation.
Repeating an intent is idempotent; adding a member owned by another task still
rejects rather than moving it implicitly.

`sessionTree(entries, tasks, directory, query?)` projects ordered task groups
followed by “Not in a task”, with parent/child depth. Helpers inherit the
nearest explicitly grouped ancestor; explicit helper membership takes
precedence. Title search retains matching ancestor paths, while missing parents
and malformed cycles cannot hide sessions. Keep each server's entries separate
at the caller.

## Commands

`new CommandHub(context, keys)` creates an empty, framework-free registry. A
feature registers `{ id, title, category, slash?, enabled?, run }` through
`register`; the returned release function is identity-bound and idempotent.
`unregister(id)` removes an explicit registration. `run(id, args)` snapshots
consumer-supplied context at invocation, checks availability and returns the
handler's value or error. Unknown and disabled IDs reject. `list(context?)`
reports title/category, enabled state and injected key labels; `resolveSlash`
resolves declared aliases. `subscribe` observes registration changes.
`metadata(id)` returns frozen, data-only owner metadata even for hidden
commands; `list` uses the same read-only projection but keeps hidden commands
undiscoverable. Neither metadata surface exposes execution handlers or
availability callbacks; invocation and its availability check remain owned by
`run`.

Features own registration and execution; the hub contains no shipped feature
list, browser globals or UI runtime. Inputs and callbacks stay with the
consumer. The plain Deno consumer in `tests/reuse/commands_test.ts` uses this
public entry to update independent selected counters, resolve aliases and
release ownership.

Commands may contribute
`context: {kind, title?, items?, order?, destructive?, confirm?}`. The kind is
feature-owned (a string or a list of shared kinds for one action), and the
optional title projects a captured target's data. A contribution can instead
return `items(data) → [{key?, title, args}]` to offer several choices through
one registration. Give choices stable keys when their order can change. The
ordinary enabled predicate and run handler receive each choice's args (or the
target data for a single action). `contextActions({kind, data})` exposes
data-only available actions, including hidden commands, without exposing
callbacks. Targets may declare `area: true` for an enclosing application region,
through the same target contract and kinds. `contextGroups(hub, targets)` keeps
the first two nonempty innermost non-area groups, followed by the nearest area's
group. The app group follows only when no non-area target was hit, including on
area-only empty space. An unavailable non-area target still suppresses app
actions. Empty groups are omitted. Shared action keys appear only in their most
specific group, so an action available both in an area and the app (such as New
session) is listed once. Destructive actions sort last; numeric order breaks
ties inside each section. `runContext(action)` binds invocation to the exact
registration that projected the action, then reprojects the current choices and
rechecks availability before ordinary execution. A released owner cannot invoke
a replacement with the same command ID. Subscribe and reproject captured targets
while a menu is open; data and availability can change independently of a
command's ID. The hub retains no DOM, selection, clipboard or target state
outside the returned action's weak owner metadata. Optional `confirm(args)`
projects an armed title as data on a ContextAction. The menu owns its
press-twice lifetime; the hub still owns invocation-time availability and
registration identity, including after an item was armed.

## Notifications

`createApprovals(rpc, lookup, factory?)` is a per-sidecar authoritative policy
and activity resource. Welcome invalidates older operations; `approvals` frames
own explicit enabled IDs and revisions. `owner(sessionID)` uses the shared
ancestor projection, and `setAuto` never applies an optimistic browser policy or
lets a stale RPC result replace a newer broadcast. `selectActivity` is an
idempotent selection intent, distinct from explicit `loadActivity` refresh and
earlier-page loading: reactive render delivery cannot refetch itself. Metadata
invalidation frames name the stored affected families and coalesce only the
selected family's activity. Policy revisions never invalidate journal reads.
Reconnect refreshes the selection and rejects previous-generation reads. Old
session and connection reads cannot publish into replacements. The owner retains
reply metadata only, never transcript parts.

`approvalAttention(enabled, lookup, linked)` is the shared waiting-for-user
projection for permission requests and index attention.
`createApprovals().attention` binds the authoritative policy. Covered requests
are automatic only while both serving transport and native link are live;
disconnected requests wait again. Index projection subtracts covered subtrees
without losing manual sibling attention or changing native metadata.
NotificationTriggers accepts this same projection and `refresh` compares
policy/link changes against its retained raw index. Shell, rows, tabs, badges,
toasts and takeovers consume that projection.

`NotificationHub(policy, run, error)` is an empty framework-free registry.
Owners register a `NotificationChannel` through `registerChannel`, returning an
identity-bound release. A data-only `Note` has an ID, kind, optional
sidecar/root reference and command-ID actions. `publish` replaces the ID;
`replace(previous,
input)` enriches only the current identity without replaying
sound. Delivery ports scope `current`, `dismiss`, `invoke` and `unavailable` to
the exact note and channel registration. `currentNote` and `invokeDefault`
retain a live logical note's default action across focus-triggered presentation
retraction, including a native click queued after focus. Viewing, replacement
and channel release invalidate that port. Stale timers, clicks and async lookups
cannot consume a newer note. Invocation never assumes that a resolved command
actually selected the session. Consumers call `viewed` after real guarded
selection and focus.

`NotificationTriggers` observes accepted index frames, using the first snapshot
after each connection's `reset` as a silent baseline. Root attention roll-ups
already include children; roots produce one keyed done/input/error note per
sidecar. Error observations remain genuine independent backend observations.
`notificationPolicy` is separately selected, injecting host preferences, focus,
visibility and viewed root. General messages use the in-page surface. The hub
itself knows no concrete channel, application, backend, browser or UI framework.
The standalone Deno notification consumer routes external job acceptance through
the public command hub and proves stale-note isolation.
