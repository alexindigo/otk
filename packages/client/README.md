# @otk/client

ProgressEstimate derives EWMA completion rate and variance-aware ETA from worker
active-work facts, resetting at scope/generation replacement. createProgress
owns the coalesced one-second publication clock, stopping it when work is ready
or released. Transcript request owners supply queued/reading stages through that
same owner. A 45-second no-advancement fallback reports elapsed/last progress
and the real wait reason, never a failure or invented ETA.

Session/list replies carry boundary-specific `load` coverage. Atomic page pushes
paint through the ordinary content-clock reducer and acknowledge first paint;
their final result advances scalar coverage without replaying bodies or clocks.
The active request identity, original view epoch, boundary, source generation
and revision fence late pushes. List waits borrow the same P5 estimator and
reserved loading row; post-paint message coverage borrows the one shell status
line.

## View leases (protocol 20)

The transcript owner acknowledges its accepted first page through the
connection's generation-fenced settlement callback. UI adapters inject an
after-render callback; headless consumers acknowledge state acceptance. A
selected warm baseline uses the same callback. No view component owns background
admission.

ServerResources owns project/selection/crumb demand and visible Sessions keys.
SidecarConnection retains that view across reconnects, sends it with hello and
fences older scoped frames. Project changes incrementally acquire their entries
and evict retired entries without deleting native or user metadata. Sessions
borrows the project's structural catalog, keeps hierarchy/task grouping in its
shared client owner and reports its VirtualList range; rows acquire scalar
digests while only selection receives turn summaries. Standalone connections
call `view({selected, crumbs: [], rows: []})` before connecting. Other projects
remain visible through P3 summaries. Prompt recall uses only the currently
viewed server/project.

Sessions mounts its measured hierarchy after its demanded list page and the
project's inbox baseline agree. Its page/query resource requests source-wide
search and older pages near the acquired end, retains last-good rows while
loading, and acquires necessary ancestor context by key. Same-project
visible-row lease changes keep readiness and keyed row DOM, including focus and
retained scroll anchors. Query replacement and reconnect fence retired request
identities, epochs and revisions. Child navigation follows the same bounded list
cursor.

After synchronous consumer acceptance, SidecarConnection acknowledges the index
epoch/revision. Consumers return `false` for rejected frames. Epoch replacement
patches rebase from the last acknowledged revision and correct unacknowledged
keys; older epochs never reduce or return credit.

Pending user permissions/questions retain minimal routing metadata across
servers through the same socket view owner. A newly acquired live pending root
can create its existing actionable notification without first acquiring the
unseen session population. Request settlement releases that metadata. Project
lamp authority is independent of whether population counts have finished
becoming known.

An attention event can precede its asking session's scoped metadata while index
credit is outstanding. The screen transcript then reacquires the existing family
attention list from the pending owner, retaining it until routing metadata
arrives, rather than treating missing ancestry as unrelated work. This uses the
ordinary cancellable attention snapshot and live-replay fence; warm unrelated
transcripts do not acquire another inventory.

## Directory and keyed metadata resources (protocol17)

`createDirectoryCatalogs({watch,refresh,codecs,factory?})` owns one demanded
resource per canonical directory; `ServerResources` owns one such collection per
sidecar. `acquire(directory)` returns an identity-bound borrower with `state`,
`subscribe`, `ready(kind?)`, `refresh`, `view(kind)` and `release`. Kind views
implement the existing catalog-owner contract without another read or cache. The
shipped selected session, composer and meter borrow those views. Active-project
demand keeps them across same-directory session visits. Last release retires the
watch, incomplete transfers and volatile values; reconnect rebinds current
demand and fences old results. External compositions inject equivalent leases
through the ordinary session/composer ports. Standalone `createModelCatalog` and
load-port composers remain independently usable.

Session bootstrap/reconnect facts are scoped to the selected server. A borrowed
directory model view keeps its own native invalidation lifetime; the selected
facade does not refresh the directory when metadata bootstrap completes. Its
standalone owned model catalog retains that bootstrap refresh contract.

Prompt mention/slash sources filter complete current lists locally. Directory
revision changes reconcile command registrations and recompute completion;
typing, range edits, agent cycling and picker opening do not refresh
inventories. Explicit Refresh and real native invalidation acquire replacements.
Pending or unavailable replacements retain last-good choices and explicit
drafts.

`createFrecencyCatalogs` shares one revisioned directory baseline and keyed
updates across borrowers, exposing one path-to-entry lookup per revision.
`prepareAttachments(parts,origin,policy,load)` deduplicates original sidecar
references, bounds origin concurrency and combined admission, preserves input
order and rejects the whole preparation if an origin is incomplete. All
submission surfaces borrow that same owner.

The inbox receives complete `{generation,revision,inbox}` baselines followed by
keyed patches. Unchanged project/task objects retain identity; revision gaps
coalesce complete-baseline recovery and stale baselines cannot replace newer
accepted state. Action receipts settle operations; only this stream owns current
task membership.

Prompt recall uses the shared `PROMPT_HISTORY_LIMIT` window. `loadHistory`
preserves originating sidecar IDs and valid partial histories when another
source definitively rejects. If every requested source definitively rejects, it
propagates that failure to the existing prompt feedback owner instead of
reporting a successful empty history. A reconnecting request remains pending;
there is no recall-specific failure timer.

## Request event consumers

`createFormIntent({capture, presenter, diagnostic?})` owns a form's captured
values, synchronous pending reservation, joined submission promise and safe
feedback. `capture` is injected so native form APIs stay at the UI boundary.
Repeated submits join before any asynchronous work; a definite rejection retains
the captured values and a later explicit submit gets a new key. Presentation
subscriptions can detach without cancelling the captured work. `failureFeedback`
handles typed request failures, silent releases and locally diagnosed exceptions
through one presenter, without rendering arbitrary exception text.

`createSubmissionIntent` separates input preparation from captured send
settlement. Repeated preparation joins synchronously and repeated sends cannot
replace an in-flight payload. A later input command can still prepare and run
while a send or its follow-up bookkeeping remains pending; command handling is
not mistaken for a duplicate send. Both lifetimes stay framework-free, with
native input and focus owned by the UI adapter.

The protocol's `RequestMetadataRegistry` is an empty, injectable description
registry. `createRequestMetadata()` selects the shipped feature-owned kind and
pending-copy contributions. A tracker composition can inject its `get(method)`
projection as its lifetime classification without adding execution dispatch to
the transport or displaying method names.

`RequestTracker` is the framework-free long-lived owner for request-event
transports. Inject `send`, optional tab identity, server identity, metadata
storage and feature-owned read/mutation classification. `connect(window, batch)`
resumes captured work in bounded batches before callers start dependent work.
`disconnect()` changes connection state without rejecting pending promises. An
optional opaque principal identity on `connect` keeps another identity's pending
operations authentication-required until their original identity returns.
`receive(event)` handles correlated acceptance, sequence snapshots, progress and
results. A missing admission in a live window resupplies the same captured
payload and key; an expired unknown window cannot become a new execution.

`start(method, params, options)` returns a typed `Operation`: observable state,
`result`, same-intent `retry` and subscriber `release`. Reservation happens
before publication/transport. Payloads are captured as JSON and cannot be
changed by subsequent edits. Read release is a silent `RequestReleased`;
mutation release detaches its surface while retaining the tracked outcome.
Metadata storage never contains params, drafts, credentials or result bodies.
Restored operations with no captured input remain input-required.
`IntentGroup.step(name)` allocates each child identity once for composed
intents.

`new Rpc(send, tracker?)` composes the typed facade over that owner; `start`
supplies handles, `call` delegates to the result, and `receive` accepts protocol
17 request events. Both `AbortSignal` and `RequestOptions` remain supported.
Without an injected tracker, Rpc constructs the same event owner. There is no
legacy RPC completion path or failure deadline.

`Rpc.intents.run(targetKey, action)` reserves a composed intent synchronously;
repeated activation joins its pending promise.
`IntentGroup.options(step, owner)` allocates each child once. Submission threads
separate promotion, send and visit keys through the common port, while deletion
and Undo retain interrupt/boundary identities. Successful action settlement is
independent of later visit bookkeeping. `Rpc.feedback(owner)` borrows request
state and retains classified local feedback by target across view replacement;
it never renders method names or exception prose. `RequestTracker.subscribe`
observes these state transitions without a second pending map.

`Rpc.ownsFailure(cause)` identifies a structured failure only when that exact
diagnostic belongs to an installed target feedback sink. Transient command
surfaces can defer to it without swallowing unrelated local failures. Server
resources expose the same optional query across their connections.

`requestAttention` decorates the existing project/task/session projections from
tracked mutation state. Pending work retains working lights and mandatory
phantoms; input-required/authentication/definite failure retains attention. This
also covers a project-owned creation before it has a result ID. Read/lease work
does not make a session busy, and native index facts are never overwritten. The
existing inbox priority owner combines native and operation attention. Resources
own one presentation invalidation subscription per server and release it on
removal/stop; operation metadata and identities still belong to the tracker.
Authoritative session tombstones retire operation-derived attention, including
late failures and attention inherited from a task or child. Automatic
bookkeeping never creates mandatory attention, even when it fails; its request
outcome and diagnostic feedback remain available independently.

`HttpRequests` supplies an HTTP event transport over the same tracker. It sends
envelopes and private receipt headers, then consumes held NDJSON events. It owns
its fetch lifetimes and same-key reconnects; liveness does not abort a slow
request or settle it as failed. Inject retry/liveness policy explicitly after
discovery, with no hidden bootstrap deadline. Stop joins owned transport work.
Lost admission delivery reattaches by receipt without submitting credential
input again. A reset bootstrap receipt remains input-required; feature
composition can re-read configured state or offer an explicit fresh sign-in.

`FailurePresenter` is an empty feature-extensible registry for safe `Feedback`.
Unknown failures use fixed copy. `RequestFailure` carries structured public
facts and a fixed message; `localFailure` reports its original cause to an
injected diagnostic port rather than rendering it. Views consume feedback
data/callbacks, not raw exceptions or method names.

Framework-free OTK networking, RPC and state. Production code depends only on
`@otk/protocol`. No Solid runtime is required. LGPL-3.0-only.

## Public API

`publicDefaultsFrom` reads the allowlisted `{ defaultPort }` session-bootstrap
projection. Connections publish it through `ConnectionSink.defaults` into each
sidecar's state. Older peers leave it absent, without a competing fallback port.

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

`ClientIndex` owns its keyed entry dictionary synchronously and publishes keyed
clocks through the binding. `get(sidecarID,sessionID)` is the invocation-current
read used by `ServerResources.entry`; accepted tombstones govern selection and
action eligibility before a deferred view paints. There is no second index in
the UI or action owner.

Only this keyed owner interprets index operations. Its operation dispatch is
exhaustive: a new wire kind cannot silently become an eviction. Application
consumers borrow reduced entries through `ServerResources.indexEntries(server)`
or the keyed metadata lookup after accepted frames have been reduced. Standalone
consumers use the same `createIndex` owner rather than implement another
decoder.

`ids(server, directory?)` borrows a structurally stable partition of identities;
`partition(server, directory?)` borrows its current keyed entries. Membership is
maintained at the index owner, with per-partition binding clocks. Status and
digest changes do not reorder identities or replace unaffected partitions.
ServerResources projects each server/project from these partitions, including
the complete activity inputs independently of mounted views.

One per-sidecar project projection maintains keyed membership, session counts,
status/unread contributions and request/approval attention. `projects` retains
unchanged row identities; `projectRow` borrows one project's selector, including
its cached `sessionIDs` and `sessionCount`. Project membership updates the
shared name-collision keys used by `duplicateProjectName`. Views do not scan
session populations. Accepted inbox changes publish their project/mark keys from
the inbox reducer; rejected gaps publish none. Digest patches and digest-only
full upserts leave metadata, project and attention reader clocks unchanged.
Request attention borrows keyed session lookups and is cached until request or
metadata changes.

When supplied, server-owned inbox `summaries` govern project lamps, counts,
unseen state and recency, with local request attention overlaid by its existing
owner. Additive `inbox.summaries` frames have their own revision fence and share
complete-inbox gap recovery. Unknown native activity never paints an idle lamp.
Standalone consumers without summaries retain the metadata projection contract.
The server's supervision projection governs lamps independently of population
readiness. Missing supervision is `none`, rendered grey as "No known activity".
There is no raw-status fallback. Unknown population counts remain null.

The inbox owns accepted metadata synchronously and publishes a binding clock,
matching the keyed index: projection observers and commands never wait for a
framework to expose an accepted mark, task or project update.

`catalog(server, directory?)` and `getMetadata(server, id)` borrow stable
`MergedMetadata` projections without digest/turn history. Membership, metadata
and complete-entry reads use separate dependency clocks in that same keyed
owner. Digest-only changes therefore do not rebuild project/activity inputs or
identity lists. `changes(server)` reports accepted identities, structural
changes and the narrower `metadata` identities; rejected frames cannot replace
that authority. `ServerResources.metadataEntries()` supplies metadata-only UI
consumers, while the existing full-entry ports remain available for digest
consumers.

Session pages publish essential session/message data independently of optional
attention and sibling reads. Optional failures retain last-good data and expose
diagnostics. Live attention changes replay over their own resource snapshot. The
selected owner consumes the coordinated `MessagePage` directly; it makes no
parallel `session.get`. Continuation stays opaque, and exhaustion comes only
from `older: null`, including exact-multiple and short pages. `latestPrompt()`
and `state.latestPrompt` supply composer/Undo metadata outside the loaded ten
messages. `state.clock` identifies accepted page authority. Pending live replay
is bounded by the connection's injected/welcomed policy. Duplicates are ignored;
gaps, epoch changes and overflow invalidate the baseline and coalesce a retry.
Failed snapshots preserve visibly refreshing last-good content until a fresh
authoritative page covers the final source, without an unbounded events array or
speculative append seed. `state.continuity` distinguishes `loading`, `ready` and
recoverable `missing` baselines. Superseding a generation retires its paging
flag. Late `agent.colors` operations decorate the existing transcript without
retaining another collection.

Replacement pages and recovery parts preserve last-good unfinished text when
native source coverage is shorter or empty. The existing stream stamp carries
optional UTF-16 `sourceLength`, so Markdown presentation changes do not
masquerade as source regression. Incoming epoch/replacement fences still apply;
explicit removals and terminal snapshots remain authoritative. Retained event
source stays refreshing across a transport gap; unaligned deltas cannot
overwrite a newer replacement-only HTTP checkpoint. Terminal recovery reconciles
the complete native source, including bytes missed during the outage.

`MessagePage.version` and `transcript.state.version` identify the producer
generation/session-boundary revision, separately from demand-epoch sequencing.
`bootstrap.complete` refreshes bootstrap-owned metadata/attention, never bodies.
`transcript.invalidated` affects its session or all sessions for a new
generation; equal, older and unrelated notices do not reacquire current data. A
held baseline already covering the notice is accepted, while a stale response
cannot install. Replacement reads coalesce; persistent stale authority backs off
instead of spinning. Opened turn-detail resources apply the same version fence.

Missing native seeds are distinct from a missing browser page baseline.
`stream.recovery` carries keyed generation/state metadata beside the canonical
bodies; pages retain that metadata through installation and older acquisition.
Full event source retires the matching refreshing state, stale generations
cannot clear newer recovery, and cooling releases it. `stream.reconcile` is a
scoped, clocked invalidation when the producer loses bounded fine recovery keys;
the same resource coalesces a replacement page. Neither operation creates
another body cache or an append seed from HTTP.

Canonical transcripts bind task-part identities to the shared reduced child
index's `digest.helper`. Borrowed digest and standalone `task.progress` delivery
use the same identity/revision reducer, so equal progress cannot apply twice.
Helper updates preserve parent source/native completion clocks and unrelated
reply identities; removal, cooling and replacement release the source-free link
index. No helper RPC, child transcript cache or timer belongs to the view.

`createTranscripts({connection, entry, factory?, clock?})` owns one canonical
`createTranscript` per `sessionKey(server, session)`. `setDemand` replaces
active scope/screen demand, `interact` refreshes that scope's clock, and
`preload` gives an attention scope its temporary lease. Resources wait for an
explicit/welcomed policy. One shared queue bounds page reads per server and
prioritizes selection, attention and recently interacted scopes. Hydration
publishes newest10 before acquiring next10. `viewport({first,last})` uses native
message identities to refill at `MESSAGE_ADMISSION_WATERMARK` (20), with a
ten-message reserve; `ensure(id)` follows the same cursor chain and `pin(ids)`
retains interaction identities. Screen and warm consumers borrow the same
bodies, not a snapshot cache. Visited pages survive while warm; a background
live tail stays bounded. Warm owners also reduce live permission/question
changes, so returning to a session cannot restore an already answered approval
target. Cooling aborts reads and releases subscriptions, replay and message
maps.

`createSession().transcripts` exposes this collection and `.transcript` borrows
the selected resource. The compatibility `state.content` references its
canonical content. Model catalogs and usage leases retain their existing
selected/open-detail owners. Tool-completion observers start a silent baseline
on selection of an already-warm resource; hydration/history cannot trigger a
historical agent switch. `createTranscriptScopes` borrows task ownership from
the shared project tabs selector. Its body demand contains only the selected
session; crumbs and other task members remain metadata-only. Attention edges in
other projects never preload transcripts. Initial membership waits for inbox
readiness. Visibility/Settings releases only screen demand. Metadata, drafts and
seen/finish state are independent of body cooling.

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

Session routes validate `isSessionID` from the protocol for both session and
optional root segments. Bare legacy links select no session and the shell
navigation owner presents the compatibility notice, without native reads.

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
unavailable flag without replacing a missing model. Inputs use the latest
visible prompt's metadata, independently of loaded pages, and primary agents in
configured-default order. Context is never copied into the draft, so unsent
explicit choices win. An absent catalog means unknown availability; only a
loaded catalog can establish that a model is unavailable. Unknown catalog
metadata also preserves a restored/explicit variant; validation and model-choice
clearing require loaded negative membership. The projection's `applies` and
`input` describe mode applicability and exact wire choices: shell omits variant
while retaining the draft's normal-mode choice.

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
owns composer catalogs and intents without a UI framework. Its derived
`state.pending` reports current catalog work, including an unknown initial
directory catalog while connected; consumers borrow it without another readiness
store. Its StateFactory notification uses the same revision pattern as
`createDrafts`: owner-current snapshots expose
capability/loading/error/last-good data even before a framework publishes its
revision. `connect()` keys in-flight work to the welcomed connection identity,
never joining or applying older work; `ready()` follows invalidation and waits
for current work. Refresh errors retain good data and do not repeatedly retry on
submission. `choose*`, serialized `cycleAgent`, `cycleVariant`, serialized
`toggleFavourite` and `recordSent` share the existing pure helpers. `groups()`
returns refs, keys, favourite flags and subtitles (only favourite/recent
groups). Dispose ends catalog publication and deferred draft intents. Captured
successful normal sends can still record recency after view replacement.

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
`createComposerSelection` accepts this optional source and forwards its neutral
`selectionIntent.agent` to the ordinary `chooseAgent` intent. Primary-agent
readiness precedes the intent, missing agents do nothing, and disposal cancels
pending switches. Historical completion never seeds a draft.

`humanDuration` owns human second/minute/hour/day status copy for both request
idle age and progress elapsed, no-progress and ETA labels. `exactCount`,
`duration` and `relativeTime` own exact audit counts, nonnegative one-decimal
elapsed seconds, and relative minute/hour/day clocks. Callers supply time and
ETA rounding; formatters install no timers. Usage retains its distinct
compact-token and money formatters. `canonicalPath` and `relativePath` use the
supplied server `PathSemantics`, including POSIX, drive and UNC roots,
independently of browser OS. File URIs stay opaque until native attachment
preparation.

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

`createTranscriptProjection` owns canonical message/part indexes, ordered reply
membership, borrowed source segments and queued state. Ordinary part changes
address one indexed message/part and reply; historical reply wrappers and
segment references stay stable. Logical keys are `reply:<turnID>` inside a
session resource, independently of acquired first/last native action boundaries.
`replyMetadata`, `replyMessages` and `queuedMessages` remain detached pure
compatibility helpers over those same primitives, including session
partitioning. Shipped rendering borrows the resource projection instead of
invoking those whole-list helpers on live frames.
`TranscriptOwner.source(id, presentPart)` acquires missing reply steps through
its original cursor chain only on explicit copy, then resolves source through
the consumer's injected part presenters.

`timelinePrompts(messages, busy?)` projects that same loaded transcript into
chronological prompt identities, creation clocks, shared queued flags and
borrowed source parts. It retains no content or paging state; consumers present
parts through their own registry and page through the original session owner.

`replyMessages(messages, busy?)` additionally projects generic pending user
requests from the current/queued turn and unfinished grouped replies. A later
request cannot revive completed history, and idle retires pending state. Views
forward that projection to part renderers; they do not infer native part kinds
or retain another transcript store.

`createSession().usage` is the framework-free shared SessionUsageOwner.
`createSessionUsage(connection, factory?, metadata?)` also supports smaller
compositions. Targets always contain `{sidecarId,sessionID,turnID}`. Explicit
`load/get` reads return `TurnUsageDetail`; `priced(target,catalog?)` caches
keyed call presentation and preserves unchanged row identities. A footer,
selected session or scope never admits detail work. Session/turn footer totals
remain authoritative keyed-index reads, independently of acquired bodies. Live
headers, tool labels and removals update only the opened turn; text does no
pricing. Held reads use bounded operation/UTF-8 replay and one delayed
replacement intent; the connection's welcomed policy supplies all limits.
Closing the last lease, deletion, server removal and stop release its calls,
pricing and replay.

Explicitly opened breakdowns hold `retain(target)` leases; the returned release
is idempotent and bound to that exact resource. Selecting a transcript,
rendering a footer or mounting Sessions never loads detail. `sessionSummary`,
`reportedTokens` and `summaryMeter` project nullable session/turn metadata from
the keyed index. Open details refresh when their own turn summary changes, not
unrelated turns or ordinary status upserts. Shared targets coalesce work until
the last lease releases, which aborts reads and removes both ledger and
published snapshot. Explicit index removals and `removeServer(id)` invalidate
targets, including held reads. One-shot load/get consumers retain at most 32
unleased targets in admission order; leased targets are never evicted by that
reuse cache. `stop()` ends the owner and cannot be undone by late frame delivery
or loading.

`priceUsage(total, catalog?)` prices the owner's exact per-model summaries, with
reasoning at the output rate. Unknown prices leave category costs null and known
zero prices remain zero. Backend-reported totals stay authoritative, independent
of catalog estimates. `usageTokens` supplies compact token labels; `usageCost`
owns one USD presentation rule for every consumer: two decimal places, `<$0.01`
for positive sub-cent amounts, and `$0.00` only for actual zero. Its `"exact"`
mode preserves the reported amount for title-free accessible detail, including
arbitrarily small nonzero values. `turnUsage` projects ordered per-call rows
with exact counts, reported costs, activity labels and clocks plus the ledger's
one turn range. The shared priced projection also supplies `context`: New input
plus cache read and write, for each call and the total. It is a prompt subtotal,
not another charged token category; `tokens` still includes each of the five
categories once. Detail Total cells retain category prices. Explicit turn reads
expose `value.summary.cost`; whole-session totals remain keyed digest-summary
reads through `sessionSummary` and `summaryMeter`.

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

`fitOverflow({keys,widths,available,required,preferred?,moreWidth,gap})`
projects one measured snapshot into ordered visible/overflow identities.
Required values never enter overflow, even if their labels must shrink.
`overflowPreference` prioritizes the root, then nearest selected ancestors, then
remaining original order, with cycle protection. These owners know no DOM,
framework or item count folding threshold. The UI retains stable frames and
supplies measured widths.

Breadcrumbs use the one-line shrinking contract, with independent More controls
for omitted identities. Task strips render the client-owned urgency/recency
order directly in a horizontal scroll lane, without overflow fitting or
wrapping.

`createInputGuard({drafts, key, confirm})` owns dirty-input marks and
confirmation policy. Release reads the invocation-current draft through
`Drafts.current(key)` (non-creating and independent of framework publication)
and clears only an accepted editor, preserving the prompt and choices;
navigation clears attention marks only when the session identity changes.
`permit` checks a single input owner without consuming its dirty state.
`release({draft: "kept" | "dropped", keys?})` states whether released stored
drafts survive. Ordinary navigation defaults to kept. Dropping unsent content
asks first, including background/family drafts named by keys; consent does not
consume those drafts before the mutation succeeds. Deleted native lifetimes keep
unsent attention input in the same guard until normal guarded release; the
metadata-only details surface can display it without a native send control.
`Drafts.drop(key)` removes committed deletions and retires captured writers, so
late uploads/sends cannot resurrect their deleted draft lifetime.

`createShellNavigation({resources, actions, guard, drafts, session, presence,
environment?, factory?})`
owns project/settings/error state, accepted routing, guarded preview/pin/open,
creation revisions and seen/visit bookkeeping. It wraps the existing
injected-history navigation owner. Later intents supersede pending creation
navigation and errors, while captured task actions retain their server and
project. `InboxState.ready` distinguishes unknown initial task metadata from an
accepted empty snapshot; list hierarchies mount after that first snapshot so
initial grouping cannot restore an anchor from invented ungrouped data. Retained
metadata stays ready across reconnects. Accepted index metadata establishes the
active project and list scope even while a direct route's transcript is loading.
View observations record first visits after content readiness; subsequent finish
observations mark seen only while focused and visible. Browser confirmation,
history and presence remain injectable. `shellTitle` is the pure
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
authoritative. Authoritative deletion retains task membership and a tombstone;
`removeFromTask` is a separate user-metadata-only action.

`createSessionActions({resources, session, current})` owns session-target
directory resolution (index, matching selected info, then authoritative lookup),
non-submitting actions and the shared submission port. Prompts resolve the
invocation-current target before admission and preserve each history
attachment's server ownership. Abort and attention replies use `act` without tab
promotion. Its live info/key projections are framework-free; memoisation stays
with the UI.

SessionActions `rename(target, title)` captures the target's server and performs
the typed mutation inside `act`, preserving directory and successful-action
bookkeeping. A phantom task's rename reserves the tab owner's existing promotion
with the captured new name, commits it only after native rename succeeds, and
does not select a late result. Pin and send share that same reservation; helpers
and already-grouped sessions retain their membership. `createSessionRename` owns
one identity-and-origin-scoped editor (`tab`, `chip` or `row`),
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
then remains pending until authoritative idle before reverting. Its history
refill preserves prompt choices and replaces only empty or identical
owner-written content. Redo unreverts and clears only the identical
owner-written draft; newer text, attachments and unsaved editors survive.
Captured draft writers cannot resurrect a dropped lifetime, and
selection/disposal retire pending waits and draft effects. `abort(target?)`
accepts a captured target for that same owner.

Intent completion waits for authoritative transcript publication, including an
in-flight resync. A rollback must remove its boundary prompt; restoring must
publish restored message identities. Only then can another intent select its
target and draft effects run. There is no browser failure deadline for that
publication wait; selection/disposal retires the observation. RPC admission
never substitutes for the consumer seeing the result.

The hierarchy owner also exports `sessionFamily`, `familyTask` and
`familySelection`. Shell's location projection intentionally matches only the
requested ID and the selected root without filtering directories; its task
membership predicate uses full ancestry and the indexed directory. These remain
distinct call shapes of the same pure task projection.

Family membership resolves the nearest grouped identity before task order. Tab
preview, accepted metadata reconciliation and remembered-session validation
share that projection, so late task/ancestry data cannot strand a helper in an
idle phantom or replace the viewed identity with its root.

`createServerResources({sidecars, index, factory?})` constructs its sidecar
collection through the injected receiver factory and owns lazily cached inbox,
approval and project-tab models. Its getters read live state; callers keep
framework memoisation at their binding boundary. `tabSnapshot(project)` borrows
a stable semantic project snapshot; `syncTabs` reads invocation-current inputs
and previews the selected session only when needed. Retained tabs borrow current
project partitions and inbox metadata, never detached whole-server entry/mark
copies. Independent `createTabs` callers can still supply their own canonical
references through `update`.

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

`createInbox(rpc, factory?, report?)` receives connection-local `inbox.snapshot`
and `inbox.patch` frames, including the snapshot sent on every hello.
`openProject`, `openSession` and `act` reset the server-owned visit clock;
opening a session also acknowledges its captured terminal token. Wrap sends,
approvals, answers and interrupts in `act(directory, callback)`. Successful
actions request activation through the same visit bookkeeping port;
opening/viewing never requests activation. Session creation is tracked by the
server's creation registration. For submissions,
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
`inboxProjects` shares the Active/Discovered/Inactive classification with the
keyed project owner. Active means known sessions, Discovered means
template-only, and Inactive requires explicit user policy unless mandatory
activity lifts it. `source` retains provenance separately. Scalar seeds own
population counts, so hydrating an existing session cannot increment them. Every
project row has a light. `INBOX_STATUS_PRIORITY` owns aggregate light priority:
needs you, finished but unseen, working, none. Project and task lights consume
supervision; presentation does not rank states. Finished children retain unseen
attention until acknowledged. Task tabs sort by this priority, then newest
family `timeUpdated`, with identity as a stable tie-break. Stored task order
remains available for future pinning; it does not drive the strip. Discovery
retains its recency/name order.

`projectHierarchy` orders explicit worktree rows beneath their repo within each
server, without merging equal repo IDs across connections. The keyed project
projection borrows topology and scalar repo/leaf status from inbox summaries;
views never scan sessions for rollups. Inactive children retain their repo
label, and working/blocked/unseen leaves remain Active under stale authority
too. That same keyed owner resolves nested metadata/tasks into their
authoritative checkout leaf and supplies exact source scopes to tabs and
Sessions. Navigation uses the leaf while promotion, execution and persisted task
directories retain their original paths. Sessions borrows bounded native pages
for those exact scopes through its existing list resources; no flat nested
project or second project projection is created. Topology changes re-route only
affected repo membership.

`createTabs(inbox.promote, factory?)` takes
`update({directory, entries, inbox})` and exposes task, mandatory phantom and
single-preview tabs. Only top-level no-task sessions can be phantom tasks;
helpers roll work and attention into their nearest task or top-level parent.
Helper navigation retains the viewed session under that tab's identity.
`select`, `preview`, `pin` (also the double-click action),
`rename(sessionID, title, callback)` and `send(sessionID, callback)` own tab
transitions. Required activity tabs never disappear when a preview is replaced;
an idle/seen selected phantom remains until selection leaves. Inputs remain
owned by their index/metadata models, and tabs never delete sessions. Concurrent
pins share promotion; late completion cannot steal a newer selection.

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
latest-context footprint. `taskBreadcrumbs(task, entries, tasks?)` preserves
explicit membership order and adds working/blocked phantom descendants of every
member. Finished helpers disappear even while selected and remain reachable in
Sessions. Traversal is iterative, cycle-safe and stops at another task's
explicit membership. Helper URLs retain their owning task; removing membership
preserves the viewed helper under its top-level parent's phantom task.

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

Hierarchy construction indexes parents, explicit membership, inherited ownership
and child adjacency once, then walks iteratively. Deep chains cannot overflow
the JavaScript stack; cycles and missing parents remain reachable. Task members
retain explicit order. `createSessionTree().rows(...)` caches flattened keyed
headings/session descriptors using stable structural/search inputs, without a
serialized population signature. The project projection supplies those inputs
through `ServerResources.sessionRows`. Live row facts continue to come from
`ClientIndex.get`, never cached hierarchy entries.

The same project owner supplies stable `projectMetadata` and keyed
`metadataEntry` selectors to tabs, crumbs and Sessions. `ClientTabs.tabs` and
`crumbs` share one keyed family/adjacency derivation; `entry` resolves crumb
titles without a population search. `ClientIndex.partition` is cached by its
partition clock, while `projectProgress` borrows incrementally maintained
digest-state counts. Digest-only frames do not rebuild metadata or hierarchy
inputs.

`createWindow()` owns browser-independent measured viewport math. Supply ordered
keys and role estimates with `update`, apply incremental sizes with `measure`,
and read `range(scrollTop, height, overscan?, pinned?)`. The result contains the
exclusive start/end, before/after space and ordered visible keys, including
disjoint interaction pins. Prefix sums support incremental measurements and
binary viewport lookup; `offset`, `size`, `total`, `anchor` and `restore` share
that same geometry. Anchors name identities and an intra-row offset, so changes
above the viewport do not turn into positional selection or scroll jumps.
Explicit pins remain materialized even when a borrowed window has zero visible
height. An optional source-free measurement map preserves sizes across a
window's virtual unmount without retaining its content.

`measured(key)` distinguishes recorded geometry from an equal-valued estimate.
Zero-height rows are valid recorded geometry, so bookkeeping with no rendered
height can release its measurement lease without being promoted to a source.
`invalidate(key)` revokes a recorded size when its source changes. Content
windows use it to reactivate dormant zero-height rows on a content revision, so
an initially empty streaming row can acquire content again. An in-viewport
zero-size collection retains its closed-edge materialization frontier, not its
whole population. That boundary can acquire content while remaining ineligible
as a visible source anchor.

Each transcript exposes `interaction`, the framework-free source-free owner of
explicit disclosure choices, generation fences, numeric window measurements and
the native/row identity anchor. Cooling keeps these small values; `stop()`
clears them. Removed identities advance their disclosure generation, so an old
handle cannot change a replacement. `ensure(id, signal?)` supports a view's
reveal lifetime without creating another body owner or cancelling other
consumers.

`createListScopes()` owns plain query/scroll/anchor interaction values keyed by
server, directory and optional task. It retains no DOM, content or observers;
server removal retires only that server's values. Views can unmount and borrow
the same interaction on return.

## Commands

`new CommandHub(context, keys)` creates an empty, framework-free registry. A
feature registers
`{ id, name?, aliases?, title, description?, category,
arguments?, scope?, instance?, kind?, availability?, run }`
once. Every command surface projects that inventory, without per-command surface
metadata. Names default to the semantic ID; the ID remains an exact spelling
when friendly names collide. `resolveSlash` and `spelling` share resolution, so
displayed names cannot invoke a different owner. Ambiguous names reject
independently of registration order or availability. `parse(name, text)` uses
the registered runtime schema: strings accept raw or JSON-quoted text,
object/array/number/boolean inputs use JSON, and an object's `rest` field
preserves the remaining text verbatim. Missing required input is unavailable,
not an absent definition. Local-only inputs cannot be manufactured by text
parsing.

Harness catalogs contribute neutral `action`, `priority` and `unavailable` data
through `createHarnessCommands`. Bindings borrow the semantic owner's current
schema, availability, confirmation and execution. Releasing that owner makes its
binding unavailable. Higher adapter-supplied priority wins friendly-name
collisions; equal priorities remain ambiguous. Exact IDs stay addressable.
Native names and version rules never enter this owner.

`skillChoices` retains skills separately and applies only an adapter-supplied
`skillConflict` explanation. Skills never register individual slash commands.
`session.command` can carry an explicit skill identity independently of a
same-named server command.

`list(context?)` returns every registered descriptor, its availability/reason
and injected key labels. `metadata(id)` returns a frozen, serializable snapshot
including the argument schema, never a closure. `run(id, args)` captures current
context and rechecks the same schema and availability before invoking the owner.
The existing `enabled` predicate remains supported with a generic refusal
reason; owners can supply `availability` for a specific reason. A context action
requiring confirmation uses the hub's injected third constructor port for
ordinary invocation; an already-confirmed context-menu action does not ask
again. `subscribe` observes registration changes; release/unregister retire the
owner identity. There is no surface-wide hidden flag or slash opt-in.
IPC/API/MCP exposure is not implemented by descriptor serialization.

`kind: "submission"` denotes an operation using the prompt's captured-send and
successful-clear lifecycle; ordinary actions default to `"action"`. Provenance
(`source`) does not select execution behavior or change the argument schema.

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
data-only available actions without exposing callbacks. Targets may declare
`area: true` for an enclosing application region, through the same target
contract and kinds. `contextGroups(hub, targets)` keeps the first two nonempty
innermost non-area groups, followed by the nearest area's group. The app group
follows only when no non-area target was hit, including on area-only empty
space. An unavailable non-area target still suppresses app actions. Empty groups
are omitted. Shared action keys appear only in their most specific group, so an
action available both in an area and the app (such as New session) is listed
once. Destructive actions sort last; numeric order breaks ties inside each
section. `runContext(action)` binds invocation to the exact registration that
projected the action, then reprojects the current choices and rechecks
availability before ordinary execution. A released owner cannot invoke a
replacement with the same command ID. Subscribe and reproject captured targets
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
lets a stale RPC result replace a newer broadcast. `retainActivity(sessionID)`
returns an idempotent identity-bound release. At least one matching lease is
required for selection, refresh or earlier-page reads. Last release aborts the
read, fences its result/trailing refresh and releases journal rows, retaining
only source-free selection/cursor state. Hidden invalidations and reconnects
issue no Activity reads; reacquisition joins one latest first page. Metadata
invalidations affect only their selected family; policy revisions do not refetch
the journal. Old cleanup cannot retire a replacement family. The registered
Activity adapter borrows this lease only while mounted and resolves row titles
through the shell's keyed `entry` port.

`approvalAttention(enabled, lookup, linked)` is the shared waiting-for-user
projection for permission requests and index attention.
`createApprovals().attention` binds the authoritative policy. Covered requests
are automatic only while both serving transport and native link are live;
disconnected requests wait again. Index projection subtracts covered subtrees
without losing manual sibling attention or changing native metadata.
`createAttentionProjection({entry,ids,children,factory?})` maintains the shared
incremental index projection, borrowing canonical keyed entries and adjacency.
Covered-subtree boundary contributions retract old ancestor paths before
topology/policy changes add new paths. Ordinary updates visit affected paths or
subtrees; global link/reset changes may visit the population once. Server
resources own one projection per sidecar and expose `projected` and
`observeEntries` with borrowed generation/revisioned `EntryChanges`. Shell,
rows, tabs, badges, toasts and takeovers consume this same projection. The pure
`approvalAttention` helper remains available for independent snapshot consumers.

`NotificationHub(policy, run, error)` is an empty framework-free registry.
Owners register a `NotificationChannel` through `registerChannel`, returning an
identity-bound release. A data-only `Note` has an ID, kind, optional
sidecar/root reference and command-ID actions. Native input notes also carry a
request-scoped dismissal key. The hub retains dismissed request identities
across presentation replacement and connection resets; a new request ID can
notify again. The shipped policy suppresses dismissed presentation and sound
while the badge and canonical blocked attention remain. `publish` replaces the
ID; `replace(previous,
input)` enriches only the current identity without
replaying sound. Delivery ports scope `current`, `dismiss`, `invoke` and
`unavailable` to the exact note and channel registration. `currentNote` and
`invokeDefault` retain a live logical note's default action across
focus-triggered presentation retraction, including a native click queued after
focus. Viewing, replacement and channel release invalidate that port. Stale
timers, clicks and async lookups cannot consume a newer note. Invocation never
assumes that a resolved command actually selected the session. Consumers call
`viewed` after real guarded selection and focus.

`NotificationTriggers.entriesChanged(server,changes)` consumes accepted shared
projected deltas. It retains only per-root comparison facts and current note
identity, never another map of full raw/projected entries. Digest-only changes
perform no historical notification comparison. Policy/link changes arrive as
real affected projection deltas; focus/view/preference changes only refresh hub
delivery. Real eviction, reparenting, archival and tombstones retract the
appropriate notes. The legacy frame constructor/read/project ports remain
independently usable through the ordinary canonical reducer and the same compact
comparison owner.

NotificationTriggers uses the first snapshot after each connection's `reset` as
a silent baseline. Root attention roll-ups already include children; roots
produce one keyed done/input/error note per sidecar. Error observations remain
genuine independent backend observations. `notificationPolicy` is separately
selected, injecting host preferences, focus, visibility and viewed root. General
messages use the in-page surface. The hub itself knows no concrete channel,
application, backend, browser or UI framework. The standalone Deno notification
consumer routes external job acceptance through the public command hub and
proves stale-note isolation.

Shipped completion notes borrow accepted inbox finish clocks through the same
projected entry deltas. They do not require a busy frame that a newer view epoch
may have superseded. A finish can precede its routing metadata; delivery waits
for that root, deduplicates its clock across eviction and stays silent for
historical baselines. Standalone index-only consumers retain status-edge input.
