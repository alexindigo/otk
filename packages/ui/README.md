# @otk/ui

Reusable Solid **2.0.0-rc.13** components, isolated feature registries, syntax
rendering and thin Solid bindings over `@otk/client`. The only OTK dependencies
are the public protocol and client entries. This library has no application/core
imports and knows no native backend.

## Composition and API

Settings owns a two-row page frame: the header stays in flow at its top and one
`ScrollRegion` fills the remaining row. Its padded content is inside that
scrollport, never a shell-imposed clearance. The serving sidecar's public
defaults supply the remote-address hint; no port table lives in the UI.

`ScrollRegion` is the shared native scrolling boundary. Its `otk-scroll` class
owns `overflow: auto`, shrinkable minima and contained overscroll. Pass `axis`
(`both`, `x` or `y`) to restrict a lane. Containment follows the owned axes:
horizontal code, diff and table lanes delegate vertical wheels to their bounded
enclosing viewport. Native fields, semantic elements and borrowed viewport roots
use the exported `scrollRegion(axis)` class binding without another wrapper. The
optional scrollbar paint (`native`, `thin`, `hidden`) is shared by the component
and `scrollRegion(axis, scrollbar)` binding. Only the transcript opts into thin
themed paint; nested scroll boundaries retain their own native paint. Layout,
content and scroll-position owners stay with their components. Borrowed
VirtualLists do not create another scrollport. Component CSS never redeclares
scrolling or overscroll policy; the architecture gate enforces this with no
exceptions, including code and table content. Full-shell application
compositions import `web/src/viewport.css` to own their hosting document's
viewport boundary. The shell keeps its existing 600px minimum below narrow
viewports and clips within that document. Chrome is bounded by its owning
region; standalone component galleries retain their hosting page's flow.

`ControlValue` owns the flexible label and square trailing accessory slot. Its
size follows the control's height/border role; icons have equal inner-edge gaps.
`ControlIcon` shares that height-derived square for leading icons and lamps.
SelectionContent accepts that leading content; icon-only selections share the
whole control cell with their in-flow selection mark instead of shrinking the
icon's centring area. Each slot resolves its size at the owning control, so
compact searches and project-height rails inherit their own height role.
Markdown tasks use the shared non-interactive TaskMarker, not disabled native
checkboxes. Its Done/Not done image name and glyph share one input, and its
square slot derives from the prose line height. The list owns a two-column
marker/content grid, keeping the marker centred on the first content line.
`Select` retains one native value/focus target under a noninteractive decorative
slot. FormSelect, preferences and ListPicker borrow these owners, including the
composer's injected trigger content. Callers supply content/classes, never arrow
offsets. Select's `containerClass` styles the whole control through a
caller-owned slot; ordinary native attributes still address the native select.
Form fills its owning body; AuthColumn and Dialog's `form` role share
`--form-width`. Dialog registrations forward `form`, `standard` or `editor` size
without dispatching IDs. Editor content flexes inside that viewport-bounded
frame.

`OverflowRow` receives keyed data, required/preferred identities, noninteractive
measurement content, live content and one overflow-menu callback. Its ordered
item frames and controls stay mounted in source order; omitted rows are hidden
and inert. More renders independent controls rather than adopting row nodes.
Fitting cannot move or replace a focused required frame. Required frames use
their current measured width; other values use their inert measurement frames.
More occupies a separate trailing grid track, so editor blur cannot move its
pointer target between press and release as the live chip width changes.
ResizeObserver and font completion belong to this component. The client owns
`fitOverflow` and ancestry preference. Breadcrumbs retain single-line
required-frame shrinking. Task tabs instead use the horizontal `ScrollRegion`:
one chrome-header-height row, equal flex widths with a 90px minimum, ellipsized
labels and a thin hover scrollbar. Vertical wheel deltas scroll horizontally
unless Ctrl/Meta is held. Selection and lane resize reveal the active tab.
`EdgeTriangle` owns a centred control-height slot and renders only available
navigation. Paging aligns the last fully visible tab to the leading edge,
mirrored going back. The client model alone orders tabs; no More or measurement
frames are used for tabs. TitleEditor can receive an external `feedbackID`, with
the same shared TitleFeedback rendered in the owner's in-flow track, so a
compact editing field and its feedback do not compete for one control-height
lane.

PaneState also accepts injected content for empty panes, centring one
left-aligned content group in the region left below chrome. Diff's automatic
style measures its own content container against `--diff-split-min`; the old
optional pane-width input remains accepted for compatibility but does not
control automatic layout.

`ToolOutput` renders complete output inside its caller's lazy disclosure body;
it has no separate preview toggle or expansion store. File/match/skill results
retain their semantic renderers. `PathProvider` accepts originating-server
`PathSemantics` as data. SessionView supplies its borrowed directory catalog's
flavor; ToolPath, Diff and tool-header presentations delegate lexical work to
the shared client owner. Independent consumers can inject the same provider
directly. The existing two-argument `relativeTarget` API retains POSIX
semantics; its optional third argument supplies a different server flavor. Badge
glyphs borrow the theme's UI font and escape it when serializing SVG. Exact
usage counts and elapsed clocks delegate to the shared client formatters.

`OperationFeedback`, `FieldFeedback` and `PaneState` consume client `Feedback`
data and callbacks only. OperationFeedback supplies a row inside the caller's
single joined ComposerNotice. FieldFeedback preserves its empty one-line field
track or two-line action track in normal flow; callers associate its ID with
their actual field. PaneState occupies a shared transcript grid cell and centres
its content without viewport offsets. Their error paint uses semantic `danger`,
separate from focus/action paint; Dark uses `#ff8080` and Linen/Stone `#b5141a`.

`feedbackState({feedback,class})` binds status/alert semantics, empty-track
accessibility and pending/error/reconnecting classes together. `FeedbackStatus`
is the shared in-flow text/action presentation used by fields, menu status cells
and pane states. Empty reserved tracks stay in flow and longer visible copy
ellipsizes while the complete accessible description remains available.
`bindFeedback(() => owner)` borrows a replaceable client FeedbackOwner, releases
the previous subscription and restores the target's retained state on remount;
it never cancels an operation or stores a second pending map.

`ContentSlot({content})` gives an injected render factory its own mounted
lifetime. Replacing data read by that content does not reconstruct its subtree;
replacing or releasing the factory does. Composer and takeover notice hosts use
the same slot, so a metadata refresh cannot reset an open rollback disclosure.
Takeover action footers use that same factory lifetime, so pending state cannot
replace the persistent primary control or duplicate its native event lifetime.

`ActionSlot` supplies one shared grid cell for an action and its pending status,
retaining intrinsic control geometry while unavailable controls are hidden. Its
focus port addresses the status; the consumer supplies the return-to-action
callback. Forms, command menus, theme saves and keymap saves use that same cell.

Native form inputs, textareas and select controls share concerned-field feedback
IDs, preserve supplied descriptions and retain submitted values while pending. A
hidden submit or menu action hands focus to its visible status cell. TitleEditor
uses the same reserved field track. Registered takeovers receive an optional
`focusNotice` callback alongside their notice content, so pending replies can
focus the one joined notice rather than a hidden action or duplicate status.
Independent takeovers without that port retain a local status cell. Takeovers
size to their visible content: local failures mount in-flow status only while
present, rather than reserving a field-feedback track. The primary action
remains in the question footer even when its pending status lives in the joined
notice.

CommandProvider can inject `failureOwned(cause)` from the client resource owner.
Menus, palette and message actions then defer an exactly correlated failure to
its retained target sink; independent/local failures keep their own in-flow
feedback. No component infers ownership from error prose or a method name.

Import from `@otk/ui`. `createUiRegistries()` creates empty `tools`, `parts`,
`prompt`, `dialogs`, `panels`, `takeovers` and legacy `docks` collections.
Choose feature-owned `register*` functions in your composition root, then
provide the collection through `UiProvider`. Registration rejects duplicate IDs;
distinct consumers have independent collections. Register before mounting.
Registries import no implementations.

`tools.register(name, Component)` receives `ToolProps`: the live protocol call,
display preferences, width, directory, waiting state and an injected child-open
callback. External protocol tools resolve by their `name`; unmatched calls use
the fallback installed by `registerGenericTool`. `ToolLine` owns the shared
collapsed summary and status/permission/error frame, so external renderers
receive the same behavior. An optional third `presentation(call)` registration
argument supplies `{icon, verb, target?, summary?, category?}` with the caller's
directory as a second context argument; path-owning features supply relative
targets. Icons accept strings or feature-owned SVG render functions. The shared
frame has no concrete tool list. The path presenter keeps project descendants
relative and outside paths absolute; body labels use `ToolPath` with the same
directory input, including instruction, working-directory and diff labels.
Structured result paths use that presenter inside `ToolOutput`; file contents
use the same `Code` owner as writes, with native first-line numbering and
extension-based highlighting. Grep results carry path, line and text. Custom
tool consumers can import `ToolPath` and `relativeTarget` from the public UI
entry to share the same body and header presentation. The presentation context
also supplies preferences: edit/patch/write owners start collapsed unless
Display's persisted Expand file changes by default toggle is on. Headers retain
paths and reported change counts; explicit disclosure choices stay owned by the
shared client disclosure owner. Helper cards start collapsed. Typed tool modules
use `tools.registerTyped(kind, Component)`, whose call type derives from the
open protocol `ToolKinds` map. Separate registration namespaces let an external
`edit` coexist with typed OTK `edit` without either renderer receiving the
other's shape. `parts.register(name, Component)` receives an external part;
`parts.registerTyped(kind, Component)` derives its shape from the open
`PartKinds` map. The same namespace separation applies to parts;
`registerUnknownPart` supplies unsupported-part fallback. Part registrations can
contribute `{work?, text?, copyable?, hidden?, frame?}` presentation data: the
message groups adjacent contributed work clocks into expandable folds and copies
contributed source text without dispatching concrete part kinds or reading child
DOM. `copyable` is cheap availability; source-bearing features can expose `text`
as a lazy getter. Framing and live action targets do not stringify reply source.
Copy invokes the canonical transcript source port, paging missing steps before
the part presenters resolve the complete reply. Action ports use optional
`ContentIdentity.ownerID` for their stable presentation lifetime; native message
and last-step IDs remain separate action boundaries. Prepending a page cannot
retire an existing reply's usage or disclosure port. Read, search, fetch, web
search, skill and task bodies render their inherited native result through the
same `ToolOutput` owner as bash. The adapter's decoded results contain user
content and metadata, not model-facing envelopes. Unrecognized formats retain
verbatim fallback. Headers alone summarize operations; bodies contain results,
metadata, diagnostics and navigation/progress actions. All UI noun-count labels
use the shared count-label helper, including tokens, reverted messages, pastes
and favicon attention. Optional display text preserves compact/locale formatting
while the numeric value owns inflection. Structural edit, write, patch, todo and
question bodies keep their typed result presentation; generic output retains its
display preference and provenance-neutral truncation notice. Unknown task agents
have an identity-free “Unknown agent” label. Bookkeeping owners render as
inspectable record rows in the same work fold. Reply metadata combines
contiguous source parts for one whole-reply copy.

`frame: "transcript"` places a contributed part outside the ordinary message
bubble, preserving adjacent normal content in its own frame even in mixed
messages. Compaction owns that declaration and renders a shared DividerLabel,
the same label/rule pattern as WorkLog: “Compacting…” for a pending request and
“Session compacted” afterward. The generic message view dispatches no concrete
part kinds. Part renderers receive the client projection's optional `pending`
input; the summary reply retains its normal rendering.

Shared message framing separates `userBubble` presentation from `prompt` action
eligibility. Only ordinary user prompts get bubbles. Neutral `context` records
and legacy contextual origins never become bubbles, prompts or Timeline anchors.
Part fallback registrations may contribute presentation alongside rendering;
explicit registrations retain their own presentation. The shipped fallback shows
an unregistered activity as a collapsed tool-style row with producer-supplied
title, muted detail and error tone, plus lazy parameters/rendered blocks and
independent child navigation. Unknown parts show their name and a byte-bounded
data preview, with the original size and an explicit truncation fact. No native
kind or state is interpreted by these shared consumers.

Fallback source inspection has its own nested `NativeSource` disclosure. The
existing client disclosure owner resolves the `source` category default and
retains explicit per-part choices independently of the activity body. Size,
truncation and bounded source text mount only while that nested fold is open. An
expanded record does not repeat a state label already shown by its heading or a
parameter. Parameter values, plain or navigable, share one value primitive, so
they align to the same column edge and baseline.

Unfinished assistant replies end with a thin in-flow glimmer beneath their last
content and before metadata. The grouped reply's completion clock owns its
lifetime, so continued backend steps share one indicator and terminal replies
have none. OS reduced motion and the persisted Animations off preference replace
the shimmer with quiet “response in progress” text between flowing rules. The
same named status remains available to assistive technology in either mode.

Missing-seed recovery is separate plain in-flow text beside the logical reply:
“Refreshing response…” while source is unaligned, or an unavailable message and
available Retry response callback after a checkpoint failure. The canonical
client resource owns this state. It does not alter supervision lights, disable
controls or add a loading overlay.

Reply footers show model-call count, charged turn tokens and backend-reported
cost after working time. Work-log headers, footers and opened detail bind the
adapter's one shared timing result. There is no loaded-page timing fallback;
missing evidence says Time unknown, with the adapter's explanation on hover. The
shared Popover's hover/focus preview reveals an ordered per-call table: existing
tool labels or answered, full prompt Context, five token categories, reported
cost and time. New input is the uncached part; a footnote explains New input +
Cache read + Cache write = Context. The Total row sums calls' Context and
retains category tokens and catalog-priced costs; unknown category prices show
token counts only. Category pricing is provided by the framework-free reply
usage owner, never reconstructed in the view. Display's persisted Show cost
toggle defaults on; turning it off hides all footer/detail and context-meter
cost figures while retaining tokens. Popover's generic wide size accommodates
comparison tables; it continues to own native anchoring, available-side viewport
bounds, dismissal and keyboard focus return. Hover/focus previews have no native
title tooltip; their accessible trigger label and linked detail description are
supplied by that same owner. Click-only controls retain their name tooltips.
ShellPorts exposes the same framework-free usage owner to registered panel
adapters. The Sessions adapter reads keyed index digests for the selected
project's sessions; rows present total.cost as quiet trailing metadata using the
shared cost formatter, including known zero. Show cost also hides these amounts
and their accessible labels. Footers, rows and meter never sum transcript pages;
unavailable metadata stays unknown while content remains usable.

`TurnUsage` receives a cheap nullable turn summary and injected
detail/open/close ports. Its preview keeps one Model calls scroll/focus region
mounted through loading, errors and complete detail, so native Tab order and
focus identity never depend on ledger arrival. Only an open preview mounts the
ledger content and retains its coalesced read; closing the last preview cancels
that worker read. Unready state is plain Digesting text and unknown categories
never become zero.

Deleted rows use shared semantic classes with a struck title, neutral text and
intact focus/selection paint. `DeletedSession` receives formatted metadata facts
and callbacks only. The shell mounts it without SessionProvider/content demand,
retains unsent input through the existing guard, and delegates its Copy title,
Remove from task and Close session actions to the shared command owners. All
native target actions recheck the framework-free eligibility projection.

All money uses the public client usageCost formatter: two decimals, `<$0.01` for
positive sub-cent amounts and `$0.00` only for actual zero. UsageCost is the
shared data-only text component for overlay, meter and session amounts, with the
exact amount in its title-free accessible description. Parent-owned footer and
session-row accessible text uses that formatter's exact mode too. Cost off
removes both visible and accessible amounts.

Turn detail mounts only while open. Its overview keeps model-call count, peak
individual prompt Context, charged tokens and reported cost visible above a
bounded ledger. Exact comma-separated ledger counts retain the audit trail;
overview counts use the shared compact formatter with exact accessible values.
In-flow Context bars share the peak scale, exposing growth and resets. Activity
truncates with full accessible text. The ledger scrolls internally, with column
headers and Total pinned vertically; Call and Activity remain pinned during
horizontal scrolling at narrow widths. Pointer travel into preview surfaces and
focus inside them retain the preview, with Escape returning opening focus.

`prompt.register({ id, create(context) })` installs a per-prompt feature.
`PromptContext` injects selection/caret/focus operations, an active-lifetime
check, error reporting and `SessionProvider`'s common session ports: typed
`rpc(method, params)`, `supports(capability)`, session ID, directory,
preferences, history, attachment resolution, dirty-state and successful-action
callbacks. The common `submit(action)` port owns task promotion and successful
inbox-action bookkeeping for normal, shell and native-command submissions;
features supply only their mode-specific RPC callback. Native-command execution
uses it whether invoked by typed slash or the palette. `act(action)` is for
non-submitting actions such as attention replies. There are no per-feature
callbacks or capability flags on `Prompt`. The session `supports` port reads
reactive advertised capabilities: an initial welcome activates already-mounted
consumers, and reconnecting retains feature owners and their unsent input.
Transport readiness is a separate input to actions.

The plain `shell/session-ports.ts` binding captures a selection once and
delegates session operations to the client SessionActions owner. Its ordinary
capabilities follow declared metadata through reconnects; history requires an
advertised capability on at least one connected server. All resource reads
remain live.

Features can provide triggers and autocomplete sources, key handling,
paste/drop, submission transforms, completion hooks, chips, actions and
overlays. Shell, mentions, slash, history, paste, attachments and editor each
own their implementation. `Prompt` owns native input, submission identity and
teardown; it has no feature import list. Native paste/drop entry points contain
both synchronous throws and rejected feature promises through the prompt's
lifetime-bound feedback port. Reply copy uses the shared captured-source copy
operation and shows a local refusal without losing content. Failed RPC results
belong to their requesting operation; only unsolicited protocol errors enter
transport-wide notification feedback.

The completion adapter binds the framework-free client `createPromptCompletion`
owner through `solidState`, forwards current input/caret/chip ranges and renders
its options/choice. Source arbitration, query invalidation and selection
transitions belong to that owner. Native key events, keyboard layers and pointer
events remain at the UI edge; prompt teardown disposes the completion lifetime.

The history adapter likewise binds `createPromptHistory` and owns only native
key/selection adaptation and command registration. Recall loading,
serialization, cursor and draft identity belong to the client owner; teardown
disposes it. History/editor/clear content replacement shares
`replaceDraftContent`, retaining the current agent/model/variant choices and
explicit Default. Prompt model and history compatibility modules re-export the
plain client transforms/projections.

The prompt textarea uses native content sizing, retaining its 48px minimum and
growing in 24px prose lines to the component's named 240px cap. It then scrolls
internally with the caret; deleting text or clearing a sent draft shrinks it.
The footer stays in flow beneath the input as the dock gives space back to the
transcript above. Editor/history replacements use the same textarea value path,
and automatic sizing has no manual resize grip or per-caller sizing logic. The
Send control stays mounted in its shared geometry for empty, pending, offline,
unsupported and attachment-blocked drafts. It is disabled with its actual reason
in its tooltip and accessible description. This primary-action exception does
not change secondary actions' hide-when-unavailable policy. Prompt and active
question, permission and form takeovers render the same `PrimaryAction` control
from the framework-free client owner. Native Send invokes that owner; Enter
prepares input through the existing submission intent. Both paths share live
primary readiness checks and the same preparation/effect callback. Local input
commands can run while a captured send settles; the intent still refuses another
send. While the composer can send, Enter never inserts a newline into an empty,
blocked or pending draft. Native request replies are additionally admitted once
per request by the connection, whatever the view lifetime. Running turns keep
Send and today's native delivery.

Image uploads contribute independent chips: one contained thumbnail beside the
label and explicit remove button, without inserting a textarea token. Shared
draft transforms preserve them across text/editor changes; normal image-only
drafts are sendable. New history image entries do not manufacture text markers,
and history bytes retain their lazy send-time resolution.

`registerFilePart` renders source-bearing image parts as contained thumbnail
buttons; other files keep the existing chip. Consumers also select
`registerImageDialog(dialogs)` to open the original source via `dialog.open`.
Registered ImageView supplies only flowing image content; DialogHost and Dialog
own the card, title, keyboard dismissal and return focus. Images use their
original aspect ratio and semantic role radii in both themes. Image buttons
expose content-scoped native IDs across rendering lifetimes. Dialog captures the
opening control's ID before showing the modal and resolves the current element
at close; controls without an ID retain connected-node focus return. Feature
content supplies no dialog-close focus handler.

Features may contribute `settings()` content to the existing footer and one
`selection(draft)` projection. `PromptContext.nextSelection()` reads that shared
projection (or the client fallback for smaller compositions). Prompt captures
`{agent, model, variant}` from the mode-aware client projection after
contributed `ready()` work and pre-submit hooks, re-reading the current draft
before capture, then passes it to every `submit(draft, parts, selection)` hook,
and to the third argument of `PromptProps.onSubmit(parts, mode, selection)`.
Successful completion clears only the identical submitted draft through
`clearDraft`; `submitted` receives the captured selection and whether a feature
handled the send.

`registerComposerPickers` renders and binds the framework-free client composer
owner through `solidState`, common typed session ports and the host preference
command. `catalog.ts` binds reactive connection identity/availability and
lifetime; catalog work, readiness, cycling and serialized preference writes stay
in the client owner. The `connectionKey` port uses the sidecar welcome version.
The common `modelCatalog` session port supplies the single client resource
shared with the meter; initial loading is joined even when a composer mounts
after the request finishes. The session binding follows connection identity and
availability. Picker opening borrows its current directory value; explicit
Refresh and native invalidations reacquire it. Last successful data survives
refresh/errors. Model search groups favourites, recent and connected providers;
star actions and successful normal-prompt recent recording persist through the
serving host's `prefs.set` command. Commands `model.choose` (Mod+'),
`variant.cycle` (Alt+T) and `agent.choose` are discoverable in the command hub.
Without the models capability the model stays plain text. Shell displays only
agent/model, matching its wire projection. Unknown catalog metadata preserves
and displays a restored variant rather than silently dropping it. Palette-native
slash execution shares the same readiness and projection.

`ListPicker` is the shared, data-injected interaction component inside
`Popover`: typed groups/items/values, selected key, optional
search/status/header/item action, `onPick`, `onOpen` and `focusAfterPick`. Its
control port exposes only `open()`. Arrow keys (including held repeats),
Home/End and Enter operate the highlighted row; selected pointers remain on the
committed row. Groups mount only while open and release their DOM references on
close. One selected/hover row box contains the pick and optional action button;
callers inject action content/icons. Provider subtitles appear only in
favourite/recent groups. Search filters labels/descriptions/search text.
Popover's general control/open hooks keep native anchoring and dismissal
internal, while content owns its focus. Closing a pick returns to the injected
prompt focus port. Shared anchoring aligns with the leading edge and chooses the
roomier vertical side, with inline/block fallbacks for viewport overflow. Footer
labels and real chevron icons share flex centring; trigger accessible names
include current values. Loading/error states do not also report an empty
catalog.

`registerSkillsPrompt` contributes one Skills picker and one typed activation
owner. The harness binds its native picker command to that owner; the ordinary
slash projection discovers it without special wiring. The shared ListPicker
opens through its existing Popover anchor/control port and retains unavailable
skills with their supplied reason. Disabled choices cannot receive the keyboard
candidate or activate. Explicit skill IDs stay separate from displayed names;
selection uses the same captured native-command submission port as server
commands and preserves the unsent draft.

Composer model labels show the provider in secondary paint before the model,
including for backend-applied and plain-label states. Full provider/model names
remain in picker tooltips and accessible names when visible text truncates. The
footer gives controls their natural width and shrinks the model control only
under actual row pressure: provider text yields first, then model text. Shared
intrinsic sizing keeps actions on the same row without a fixed label cap. Picker
triggers reserve their chevron and padding through a flexible-label grid; when
the settings' intrinsic minimum and actions cannot share a row, whole controls
flow onto the next footer line rather than paint over one another. Agent and
variant names use display-only title case in triggers and menu rows; literal
fallback phrases stay sentence case through the same name/fallback formatter.
Keys and submitted values retain their exact spelling. Edit prompt uses the
shared 28px pencil icon button with its accessible name and tooltip.

Backend-applied composer values use the shared `is-applied` trigger state and
`--applied-fg` theme token, with the same text and geometry. The generic trigger
includes its default origin in the accessible name. Explicit/restored choices
remain unmuted. The client supplies both applied values and selected variant
row; choosing Default can show a configured variant while the Default row
retains its pointer and names that applied value in secondary text.

`registerAutoApprovePrompt` contributes a28px Auto-approve shield, selected
before the variable-width pickers in application composition to lead the footer.
Its enabled state uses the theme's action-text accent through the shared
`toggle({on})` binding: `is-on` and `aria-pressed`, without selection marks. Its
accessible name and state tooltip remain stable. The shell selects the same
server-owned approval resource for session ports, tabs and panels.
`permission.auto` captures its writable session at invocation, has the
Mod+Shift+A binding and remains discoverable in palette/Keys; enabling asks
before superseding dirty permission feedback. The browser never runs an approval
loop or clears the form optimistically. Helpers remain read-only and inherit
their session's policy. Auto policy is shown only by the composer footer, with
no marks or accessible-name suffixes on tabs, breadcrumbs or Sessions rows. The
shared client attention projection keeps covered pending requests quiet while
linked: an in-flow “Auto-approving…” status accompanies the ordinary composer,
with no takeover or manual reply actions. Losing the serving or native link
restores user attention through the same projection used by notifications and
chrome counts.

`registerActivityPanel` contributes the session Activity view through the open
panel registry. Its thin adapter forwards idempotent selection to the client
owner through an identity-bound mounted Activity lease; unmount releases it. Row
titles borrow `ShellPorts.entry(server,id)`, never a full-index search.
PermissionActivity receives data/actions, shows manual and automatic reply
outcomes with the same PermissionSummary as approval surfaces, and offers
earlier-page loading. The panel host knows no permission implementation.

The add-project adapter binds the client `createProjectPicker` owner to selected
sidecar/welcome metadata and typed scan/add RPC ports. The owner holds scan
generations, cancellation, current results/errors and captured add/open/close
transactions. Native server/path fields and rendering remain in the dialog;
unmount disposes its owner so late operations cannot navigate from retired UI.

`takeovers.register({ id, capability, component })` supplies composer attention
owners. `ComposerTakeovers` mounts capability-available components; they read
session state from context and construct their own UI. Optional feature-owned
`active(session)` predicates suspend the ordinary composer while attention owns
its area. The prompt's draft survives the takeover. Read-only helper transcripts
mount those same attention owners; only prompt submission is unavailable. With
no active takeover, helpers mount no empty composer. That same owner provides
composer availability to takeover headers, so draft-kept copy appears only when
the open session offers a composer. Permission docks and notifications share
RequestAge presentation and the client's requestIdle formatter/resumption
threshold, using the asking session's activity clock rather than request age.
Permission and question surfaces replace the composer with a raised, bordered,
20px-radius Takeover and a common blocked-light header. Consumer-supplied
session location names the project/task; question tabs/options use shared
underline/pointer primitives. Static keyboard hints are in titles, Keys and the
palette, not the surface. Question step/collapse changes focus a visible option
or review action; leaving an own-answer field focuses Answer. Arrival does not
focus an answer action. Takeover layout sections are programmatic-only
landmarks, not Tab stops. The prompt restores its own input when a takeover
releases focus to the document, while preserving focus the reader moved
elsewhere. Shared focus paint admits semantic controls and explicitly marked
visible content (message/date reveals), never layout wrappers or
programmatic-only targets, including browser-focusable scroll containers. Actual
keyboard controls retain visible focus. The composer's rounded border owns
focus-within rather than a second textarea rectangle; own-answer input focuses
its visible row. ComposerTakeovers delegates field paint through
`--prompt-input-outline`; without that enclosing box, a standalone Prompt
retains its own field focus outline. Permission takeovers and notification
toasts share one PermissionSummary: exact tool, command/working directory, edit
file paths/counts or generic target and requested patterns. Notification
enrichment carries the neutral request alongside its originating action through
the hub's opaque detail port. A permission-owned adapter supplies injected toast
content; the generic hub and toast host know no permission schema. Permission
and question owners preserve dirty state through reconnects. The legacy `Docks`
API remains independently reusable for existing consumers.

`dialogs.register({ id, title, size?, component })` installs feature-owned
dialog content. A single `DialogHost` handles `dialog.open({ id, input? })`
through the command hub. Every invocation owns its mounted content, input,
dismissal and close callbacks, even when opening the same dialog ID again. It
returns an identity-bound close handle, so a stale completion or feature
teardown cannot close a replacement dialog. Command, keymap, theme, editor and
add-project features own their registrations. `DialogHost` wraps every
registration in the native `Dialog` owner; optional `commandId` preserves
feature close IDs and `dismiss(input, close)` routes dismissal through feature
state when needed; its close callback is bound to that invocation and remains
safe after asynchronous confirmation or replacement. Palette likewise invokes
its injected `onClose` after a successful action rather than requiring a
host-generated command. Content never creates a second dialog, title or card.
The internal `Surface` owns boundary, paint, padding and title/body/action flow;
only `Dialog`, `Popover`, `Menu`, `Toast` and `Takeover` specialisations may
consume it. `Popover` owns native top-layer anchoring and outside-click/Escape
dismissal, `Menu` supplies a normal-flow item column and `Toast` supplies the
card in the fixed notification stack. Overlay tokens and the
content/popover/dialog/toast layer scale live in `theme.css`. Fieldsets and
legends are layout-neutral grouping, never cards.
`panels.register({ id, title, icon, capability?,
component })` contributes
right-panel views. Icons may be strings or feature-owned render functions; the
host does not dispatch concrete view icons. `RightPanel` mounts available
registrations with a neutral icon strip, keyboard/pointer resizing (280–480px,
320 default) and injected layout persistence. Unknown or unavailable stored view
IDs fall back to the first available view without overwriting the stored
preference. `registerSessionsPanel` contributes the project-local, task-grouped
searchable parent/child tree. Its feature adapter reads common `ShellPorts`
resources; the panel knows no views.

RightPanel's body owns one content column for headings, feature content and
empty/loading/error feedback, including adapter fallbacks and host failures.
Panel features own block spacing only. EmptyState borrows the body's inline
inset input instead of adding a second inset. Loading feedback uses that column
directly rather than a selectable list-row track.

Only the selected available panel component mounts while expanded. Switching or
collapsing releases its component, commands and observers. The Sessions feature
mounts only its active project, borrowing project entries, keyed current facts
and framework-free list interaction state from ShellPorts. Search and the
identity-based scroll anchor survive panel/project replacement without hidden
view DOM. Project lights and required phantom tabs use the complete index and
remain independent of these presentation lifetimes.

`registerTimelinePanel` contributes Timeline between Sessions and Activity in
the application composition. Its adapter projects `ShellPorts.transcript`
through the client `timelinePrompts` helper and the part registry's source
presentation. The shared `messageFrames` projection owns both transcript framing
and prompt eligibility: Timeline lists a message iff that projection marks it as
a prompt, independently of its bubble presentation. Transcript-only markers and
hidden-only messages are omitted; mixed ordinary content remains a prompt. Rows
share prompt context targets and `MessageActions`; the most recently revealed
row uses the shared vertical selection. Load earlier prompts pages the same
client session. The hidden `transcript.reveal` command belongs to the mounted
SessionView; Message exposes a reveal control that scrolls and focuses its own
bubble, while the viewport suspends tail following for that explicit navigation.
No panel reads another component's DOM or maintains a second transcript store.

Sessions and Timeline use the same `ListRow` frame: shared 30px height,
selection pointer, highlight bounds, padding and leading/label/trailing slots.
Consumers inject content and callbacks. Timeline's trailing clock/actions share
one grid area; visibility switches on hover intent, keyboard focus or selection
while the cell keeps the larger intrinsic width. Action hit targets do not move,
and the label has no independent inset hover highlight.

ListRow's `--list-row-height` is also its editing control track. Primary
leading, input and trailing slots share that track while validation prose wraps
below the input and contributes its real height to measurement. TitleEditor owns
feedback wrapping independently of the surrounding single-line control label.

`VirtualList` is the reusable viewport over public client `createWindow` math.
It receives keys, role sample classes, render content, optional pinned keys and
plain position/control callbacks. It measures those shared CSS roles and mounted
items with its own ResizeObserver; there are no copied session/header offsets.
Normal-flow spacers retain geometry, with five extra rows per side for Sessions
and zero overscan for transcripts. A window can borrow its enclosing viewport;
reply segments, part/block collections and diff lines use that same geometry
without nested scroll boxes. Shared CSS roles estimate unmeasured rows; retained
numeric measurements and identity anchors correct them. Initial nested mounts
measure without moving their parent. Content is constructed once per keyed
lifetime, with live data in nested bindings. `control.reveal(key, options)`
waits for mounted, stable measured geometry and invokes its injected focus
callback before releasing its measurement pin. `anchor()` / `restore(anchor)`
expose source-free navigation without consumer DOM access.

One root-shared position owner in `viewport.ts` alone writes the viewport's
scroll position. Every borrowed window registers identity geometry from
`createWindow` and requests layout/reveal/restoration intents; it never restores
the root independently. `followViewport` is an intent facade over that same
owner. The owner retains anchored identity through measurement transactions,
distinguishes native clamping from newer input, and follows the physical bottom
only while follow intent is active. Frame/hunk scopes distinguish sibling
collections without duplicating geometry math. Message's exposed reveal control
focuses its visible bubble after owner-controlled positioning.

The same root publishes one immutable revisioned geometry snapshot: bottom
distance, viewport height, follow intent and acquired source ends. Consumers
subscribe rather than install another geometry observer. Pending descendant
measurements cannot publish an uncommitted snapshot. Window notifications keep
their one-microtask publication path. `latest(ready)` coalesces repeated
requests, retains the source anchor until canonical tail authority is ready,
then uses the ordinary measured follow path. Upward input, explicit navigation
and retirement cancel it, including late readiness. SessionView registers
`transcript.latest` once for the button, palette and `/latest`. The control is
an absolute overlay inside a relative transcript wrapper, centred at its bottom
edge with one `--jump-bottom-inset`. Composer/takeover content stays outside
that wrapper, so the control never covers it. Hidden or shown, it reserves no
layout space and never changes transcript/composer geometry. It appears only
more than one viewport from the bottom; temporary coverage of transcript text is
permitted there. Only the visible button accepts pointer input; the lane passes
it through. The existing icon button borrows menu/popover background, border,
foreground and shadow tokens, so its raised surface separates the arrow from
underlying text without introducing paint tokens or changing its geometry.

New or changed visible rows hold temporary measurement leases through their
ancestor windows. The lease ends only after actual DOM size has been recorded,
so a large code/diff body cannot be recycled using its earlier estimate while
tail follow is positioning the root. Mounted row bounds supply geometry; absent
rows use `createWindow`'s retained measurements/role estimates. A reveal settles
on measured viewport-relative bounds even while preceding content grows, then
retains that requested identity as its anchor.

The root's revisioned geometry transaction joins keyed reconciliation, nested
materialization, recorded sizes and position compensation before paint. Pending
descendant measurement leases prevent settlement and source transfer; quiet
frames do not establish readiness. An anchor is an intersecting measured leaf
row, retained together with its enclosing row chain. Estimated spacers locate
mounting work but never become anchors; entering one retains the adjacent
measured source until the new content is measured. Solid's flush/settled
boundary joins its deferred DOM reconciliation to the same geometry commit.

Native selections pin the complete intersecting logical range before recycling,
including interior child windows and reverse selections. Select all in a focused
transcript materializes the acquired range before establishing its native Range.
Focus and shared Popover/ContextMenu origins use counted lifetime pins through
dismissal and focus return. Transcript source visibility reports native message
identities to the canonical resource's reserve port, never grouped-reply counts
or top-edge pixel thresholds. Timeline borrows that same resource and windows
its acquired prompt rows; reveal ensures the source before mounting/focusing it.

ToolFrame and WorkLog accept lazy `body()` factories, shared by typed, external
and fallback renderers. Closing destroys source rendering, observers, timers and
highlight requests; the transcript's framework-free interaction owner retains
only explicit choices and identity generations. Category defaults come from that
same owner; explicit true and false win over later Settings changes. Reasoning
keeps its toggle even when the saved default is Show. Required failure rows open
their work group by default while leaving their tool body collapsed; lifecycle
status and interpreted result failure remain independent. TranscriptSettings
uses the existing preference registry and authoritative save/broadcast controls.
Each disclosure category has one positive default-expansion toggle. Thinking and
file changes retain their old stored values through the registry's toggle
mapping. The separate Tool visibility section labels the existing successful-row
and unrecognized-result visibility switches without treating them as expansion
defaults. Code consumes an injected content lease (or its own standalone lease).
Shared highlight cache entries track their live leases and evict token source
when the last lease cools; worker names and shared grammar preparation carry no
source.

Focus, editing and shared context-menu origins pin their identities until their
owners release them, including across search exclusion. The context-menu owner
announces its origin lifetime through the generic bubbling `otk-context-retain`
event's release callbacks. No session action or overlay is implemented by the
viewport. Session rows retain named group context and their position/set-size
semantics even when adjacent rows or headings are unmounted.

`SidebarRail` is the shared frame for both collapsed sides: one 48px rail, 52px
corner reservation, leading controls, scrolling body and optional footer. The
shared `--rail-width`, `--chrome-header-height` and `--control-size` tokens own
those dimensions and compact controls; corner clearance derives from the control
size. Collapsed width belongs to the rail's CSS, never a second numeric view
policy. Expanded width defaults and validated bounds come from protocol's
immutable `SHELL_WIDTHS`, also consumed by ARIA, keyboard and pointer resizing.
ProjectInbox also uses this frame when expanded. Search stays in its expanded
vertical slot above the project lights; collapsing never moves their y
positions. The right rail stacks available registered panel icons with vertical
selection; activating one atomically selects and opens that panel through
`onLayout`. Its selected content unmounts when collapsed; retained interaction
belongs to the feature's framework-free scope owner.

`Shell({ theme, api })` binds `createShellState({api})` and composes the
reusable three-region shell with selected UI registrations. The thin Solid
binding constructs client resource, session-action, input-guard and
shell-navigation owners, injects browser confirmation/presence and installs
split view/tab effects. Shell registers commands, observes frames and renders
chrome through those ports. `ProjectInbox` renders the shared client projection
in its column and 48px rail; it does not recompute roll-ups, unread or ageing.
Tracked rows precede the persisted, initially expanded Discovered disclosure and
Inactive section. Collapsed discovery retains working/blocked/unseen-finished
rows; the rail retains the same discovery-section geometry and mandatory
indicators. Template-only rows reserve the same marker track without a lamp (a
name initial identifies them in the rail). Discovered row context offers the
shared captured New session action, while tracked rows retain their
active/inactive action. Add project creates an initial session rather than
tracking an empty directory alone. Width (200–360px, 248 default) and collapsed
states follow the serving server's `shellLayout` preference. Controls pass
independent `Partial<ShellLayout>` field intents through `onLayout`; the shell
sends `layout.patch`, whose core owner merges against persisted state before
validation/save/broadcast. No control constructs a whole-layout replacement from
props. `ProjectTabs` consumes the public client tabs model,
server/project-scoped task actions and injected guarded navigation. It renders
task/phantom/preview tabs, ordered foldable breadcrumbs with helper nesting and
reported usage, using 8px status lights. Shell-owned 28px corner toggles stay at
a shared 12px offset across full/rail and right-open/closed layouts; each top
bar reserves the corner zone. The 52px centre bar contains quiet task pills and
injected Display options; the breadcrumb owns the selected session title and
path tooltip. Reported usage fills the context bar against the reporting model's
catalog context window; unknown windows show tokens without an invented
denominator or bar. The inbox has 32px rows, hover-revealed menus, Search and a
compact settings/keys/server footer; Sessions has 30px rows and CSS child
guides. Chrome uses the shared selection pointer/underline, and shortcuts remain
in tooltips, Keys and the palette. `registerTaskDialogs` contributes its name
editor to the dialog host. Tabs have no per-tab menu; their owner-scoped
commands and package-internal task handlers retain pin, naming, moving, adding
and closing actions independently of presentation. Project rows own selection
around their flowing open button and trailing cell. That cell reserves visit
time and menu trigger in the same grid cell, revealing the trigger on hover or
focus without shifting content or positioning it over the row. `session.preview`
and `session.pin` are guarded command ports for the Sessions panel; preview
replacement cannot remove required activity tabs. `ProjectSessions` consumes the
framework-free client hierarchy and injected open/pin/create actions. The
shell's existing navigation guard protects draft/attention input, including
same-event slash navigation and browser history. Project-only URLs support empty
projects. Opening or acting resets visits; a loaded viewed session records seen.

`createIndex`, `createSession`, `createSidecars` and `solidState` bind the
framework-free client models to Solid stores. Connection options, including the
local API base, are supplied by the consumer; package URLs are never used to
discover an application's address.

`Blocks`, `Code`, `Diff`, `Message`, `ToolLine`, `ToolFrame`, `ToolOutput`,
`Prompt`, `SessionView`, `ProjectInbox`, `ProjectSessions`, `Sidebar`,
`Settings`, `Login`, `Setup`, dock and display components are independently
reusable. The shared highlighting worker owns its existing bounded cache/capture
lifetime; consumers inject all navigation. Its TextMate metadata and WASM asset
use Shiki's public `textmate` and `onig.wasm` exports. Asset-aware bundling
resolves the literal dependency URL; the worker fetches the same pinned binary
into worker-owned complete bytes. The accepted initialization callback
constructs `WebAssembly.Module` and `WebAssembly.Instance` synchronously in that
worker, preserving immediate termination without an asynchronous streaming
validator or persistent cache. Native Deno module workers resolve that same
public export with `import.meta.resolve`, so direct workers also avoid consumer
install paths.

Code layout and highlight capture share one normalized snapshot of text,
language and streaming state. Replacing a message/header with equal code values
preserves that snapshot and token nodes; unrelated metadata publication or theme
paint cannot admit a duplicate capture or cache-disposal message.

The dependency-free highlighting policy owns the 32-row source-group contract.
Source coordinates, raw layout, worker preparation/progress, cached replay and
the renderer's complete-group path consume that same constant; changing a group
size cannot leave a different layer on its own copied boundary.

Interaction durations stay with their component owners. StatusLight supplies its
250ms blink duration to both the pulse timer and CSS animation through one
custom property; Prompt's 5-second interrupt window owns its deadline and
disarming timer. The shared `hoverIntent` owner reads the theme's opening and
closing tokens once per lifetime and owns timers and focus across a trigger and
retained portalled regions. Popover consumes it for every preview: pointer
motion restarts `--hover-open-delay` (500ms); leaving cancels pending opening.
Trigger and portalled panel share `--hover-close-delay` (150ms), so surface
travel and re-entry retain the preview. Keyboard focus and explicit opening
bypass the hover delay. Reduced motion does not change either interaction
deadline.

## Example

[`example.tsx`](./example.tsx) renders a generic tool with only the selected
fallback. An application can add `ui.tools.register("my-tool", MyTool)` without
editing this package or a dispatcher. `tests/reuse/custom-tool_test.ts` drives
an independent public-entry browser consumer with custom tool, part, prompt and
dock registrations and verifies rendered updates, callbacks and isolation.

Theme tokens and base controls are loaded with the UI provider. Components
import their own CSS using `with { type: "text" }`: Deno's stable asset
attribute validates the publication graph while Vite bundles the same styles
normally; no CSS loader plugin or generated style mirror is needed. Consumers do
not activate component paint with a wrapper class. `Blocks` owns its prose root
and accepts `conceal` and `compact`; text and reasoning adapters pass these
inputs explicitly. Recursive blocks share that root, and Code owns optional
fence markers. WorkLog imports its own paint; view headers/empty states and
change counts use explicitly imported shared styles. Journal-entry styling stops
at the entry boundary, preserving PermissionSummary's file and scope lists.

`ProjectTabs.reserveTrailing` reserves consumer chrome space without reading a
Shell ancestor. Popover's `triggerClass`, forwarded by Menu, CommandMenu and
ListPicker, is the caller-owned trigger style slot. Chrome search/chevron icons,
ModelLabel and SelectionContent likewise accept a caller class. Consumers style
their supplied class/content rather than another component's private wrapper or
descendants.

Breadcrumb folding and command-menu separators are projected from one coherent
list snapshot into identity-bound rows. Keyed views consume those flags instead
of looking up their old position in a changing parent collection; menu rows keep
the exact hub-owned action reference for invocation. Replacement, shrink and
reorder therefore cannot make row presentation dereference a different item.

The shell keys each project subtree to its captured project identity.
ProjectTabs supplies its control lifetime to the plain task handlers: retirement
cancels publication waits and late navigation, while captured task mutations
still finish in their original project. The shared client tabs model is not
stopped by a view.

Consumers bundle IBM Plex Sans 400/500/600 and IBM Plex Mono 400/600; all
selection uses `--font-ui` / `--font-mono`. Interface text is 13/20, prose
14/24, headings 16/24 600 and metadata 12px sans; mono is for code, paths,
commands and IDs. Matching size treatments consume the shared `--text-*` roles;
`--line-ui`, `--line-prose`, `--line-heading` and `--line-meta` own their line
metrics, including the root and mono code/path treatments. Base buttons are
ghost controls. The shared base keeps button, button-role, tab, menu,
disclosure, pill and chip labels on one line and prevents actions shrinking.
Rows wrap whole controls when appropriate; variable content uses
`otk-control-grow` to yield space and `otk-control-label` to ellipsize,
retaining full text in a title and the accessible name. `otk-control-row` wraps
whole actions when their intrinsic minima cannot fit. The label slot owns
single-line text itself, including section/group headings that are not buttons;
their decorative rules yield before the title ellipsizes, with its full text
retained. Elastic labels combine both slots to contribute no intrinsic width, so
long text yields before a row wraps its controls. Component styles do not supply
their own control-label whitespace policy. Separate picker subtitles remain
separate lines. The code/small text floor remains independently owned by
`--text-minimum` (12px). `.otk-pill`, `.otk-icon-button` and `.otk-send-button`
provide action pills, 28px icons and 32px circular Send. Radii use shared role
tokens: controls/rows 8px, inline code 5px, cards 10px, bubbles 18px and
composer 20px. Accent is reserved for primary actions and focus. Source
selection and code geometry retain their existing contracts. Transcript,
composer and takeovers share `--lane-width: 736px` (the prototype's 46rem at its
default 16px root), centred within 24px gutters independently of the 13px
interface root. User bubbles occupy at most 80% of that lane.

Lists opt into `data-otk-selection="vertical"` or `"horizontal"` and spread
`selection({ selected, kind, class? })` onto each item. This binding alone owns
the `is-selected` state class and role-appropriate `selected`, `current` or
`pressed` ARIA state. `candidate` marks an action the keyboard will invoke; an
independent candidate may accompany committed multi-choice answers without
changing their pressed state. All selection paint keys on the state class. Items
may pass `highlighted` for a separate keyboard/hover fill without moving the
committed pointer or ARIA selection. Items place their children inside
`SelectionContent`. Vertical items reserve a leading grid track with an
always-present `::before`: a centred 3×14px pointer, 3px from the item's start.
Horizontal items reserve a 2px bottom grid track with an always-present
`::after`, inset 8px from both ends. Only the state class paints the marks.
Neither decoration uses positioning; selection never changes box size. Hover
alone only fills; reduced colours retains both indicators.

Binary buttons use the same state-binding module's `toggle({on, class?})`, which
owns `is-on` and `aria-pressed` together. Shared theme paint supplies the
on-state accent, without selection classes, orientation, pointer or underline.
Native checkboxes retain checked semantics; disclosures retain expanded
semantics. Panel tabs and question choices remain collection selections with
their marks.

Package units live in `tests/`; real browser/app tests remain at repository
level. Builds/tests run inside the project's assigned VM. License: LGPL-3.0-only
(see `LICENSE`).

## Command input and keyboard

`CommandProvider` supplies a public client `CommandHub` and optional
`createKeyboard` dispatcher. Components own their registrations through
`ownedCommand` / isolated `ownedAction`; registration starts at Solid's settled
mount and releases on unmount, so speculative replacement does not overlap a
previous session's actions. `ownedAction` keeps a semantic name plus a separate
instance scope; each instance remains addressable by its full ID.
Argument-bearing owners declare runtime schemas rather than relying on discovery
suppression to protect handlers from missing input. Consumers continue to supply
data and callbacks.

Providers expose explicit port values, never their composition props object.
`CommandProvider` preserves live `commands` and `keyboard` access without
exposing `children` or unrelated props. Consumers may copy those ports without
evaluating render factories or constructing another component lifetime. The
architecture gate rejects provider props passthrough, including aliases and
implicit copies.

Native event bindings follow their component's DOM lifetime. The shared native
compiler configuration disables delegated dispatch getters; forwarded attributes
and dynamic native controls use one native-attribute binding for live
attributes, handler replacement and listener teardown. Native `currentTarget`,
callback receivers, tuple handlers and listener options retain their DOM
semantics without keeping a retired input's event path and source alive.

`makeKeymap` ports kosmozoo's data bindings, canonical modifiers, bare-letter
matching, overrides, conflicts and resets. Bindings contain a command ID, never
an execution callback. `bind(descriptor, when?)` returns an unregister function.
Text fields are protected unless `inPrompt` opts in; `Mod` is Ctrl or Meta on
macOS. `createKeyboard(...).start(document)` owns listeners until the returned
stop function runs. Layers contain close-command IDs, a predicate and priority,
with latest registration breaking ties. Composition and repeat events do not
invoke commands.

`Palette` and slash completion enumerate the injected CommandHub, with no
per-command surface tables or opt-in flags. Slash spelling and typed invocation
use the hub's single resolution/schema owner. Both surfaces currently omit
unavailable commands from the ordinary list and search results using the hub's
existing availability projection. Availability changes restore or remove rows
while it stays open; invocation still rechecks through the hub. No disabled
command buttons are rendered. `KeysHelp` lists the injected keymap, checks
overlap conflicts and supplies proposed overrides to `onSave`. Production OTK
uses the host core's ordered `keymap` preference broadcast; failed saves do not
optimistically change bindings. The shared Dialog owns focus return, modal
keyboard priority and styles, including the prompt editor. The essential shipped
bindings are Tab/reverse agent cycle, Enter submission, Mod+K palette,
outside-text `?` help and top-layer Esc before double-Esc interrupt. Shift+Enter
inserts a newline through the prompt-owned input port.

The shared `commandHints` binding observes keymap registration, override/reset
and command lifetimes. Prompt and inbox tooltips consume current command keys,
including prompt input commands; unbound actions have no shortcut hint. Dialog
and Editor contain no static surface hints. Permission's 1/2/3 keys are fixed
widget data shared by its local dispatch and titles, active only on non-text
controls in normal mode. Question's fixed Escape layer first leaves an answer
field; with question controls focused it skips. These widget/layer interactions
are separate from remappable command bindings.

## Context menus

`ContextMenu({root})` owns the shell root's single capture-phase contextmenu
listener. Right click opens the shared Menu at a point anchor; Shift + right
click leaves the native browser action alone. Textareas, text-like inputs and
contenteditable fields always keep the browser's native menu, including spelling
and dictionary actions, for right click, ContextMenu and Shift+F10. Elsewhere,
ContextMenu and Shift+F10 use the focused element's full bounds; body focus uses
the no-target app fallback. Features attach
`ref={contextTarget(() => ({kind, data}))}` to declare current identity/data
without installing listeners. Compose with another ref through Solid's array
form: `ref={[elementRef, contextTarget(target)]}`. Commands contribute the same
kind through their public client context metadata; the owner resolves the
composed path innermost first. Target registrations release their callbacks at
the binding owner's cleanup, even when a native DOM reference outlives the view.
The client groups available actions, and the UI separates target groups and
trailing destructive actions. At most two non-area target groups are shown, then
the nearest enclosing area group. Areas declare `area: true` through the same
binding. App actions follow on empty area space or no target, but never when a
non-area target was hit, even when that target has no available actions. Shared
area/app actions appear once. Built-in selection outside fields, link and image
targets require no binding.

Menu owns role/menuitem semantics, roving focus with arrows/Home/End, type-ahead
and Enter/Space activation for all consumers. Tab closes and restores origin
focus; Popover alone owns Escape and its focus return. `CommandMenu` shares hub
projection, registration-change subscription, invocation-time reprojection and
owner-bound execution between pointer and visible-trigger menus. Failed actions
use a sibling alert described by the corresponding item, outside `role=menu`,
with an optional injected error callback for row feedback. The supplied
`feedbackID` associates that row-owned error with its action. Pointer opening
focuses the programmatic-only menu container, without a ring; the first arrow
moves focus to an item. Keyboard opening focuses the first item with the shared
focus paint. Popover carries that opening reason for both native triggers and
its control port, including modal re-hosting. All Menu callers share one compact
token set: 28px rows, 8px inline/4px block inset and no inter-row gap. Menu
passes that density through Popover to Surface; command errors mount only while
present, below the menu rather than reserving empty feedback space. Point
anchors prefer their bottom/right quadrant at the captured pointer, flipping
only for overflow. Popover owns point placement, viewport flipping and focus
return through its `open(anchor, reason)` control port. A rect anchor supplies
x/y, optional width/height (zero for a point), origin and a focus callback. One
Popover-owned anchor box uses the same CSS position-area and native flip
fallbacks as triggered popovers; it needs no resize listener/ResizeObserver.
Content never measures or positions its parent. Selection Copy outside fields
writes its captured text through the browser clipboard API. App fallback actions
use the existing session, palette and registered display-settings command
owners. DisplayPreferences shares one control body between the anchored Display
menu and the registered app-level dialog.

Display, Appearance and Notifications delegate native fields to
PreferenceControls. Each accepts the consumer's selected preference registry;
feature-contributed settings groups supply section membership. A native change
captures intent and immediately reconciles the field to authoritative prefs;
settlement re-reads the latest broadcast, including after a rejected save.
Readiness is checked at the action boundary, with focusable controls and local
error feedback.

Both column views bind the same native resize lifetime: immutable origin,
pointer identity/capture, transient final width, one-shot persistence,
cancellation, lost capture, keyboard bounds and readiness. Teardown releases
capture and retires late cleanup. Edit/Patch share a FileChanges collection and
count projection; their feature owners retain inline-label policy and trailing
diagnostics. Chrome, tool and takeover paths share the SVG frame; the takeover
reuses the chevron. Prompt and own-answer fields share native content sizing,
including restored values; autocomplete rows use the same permanent vertical
selection pointer as other lists.

Native placement first tries the painted Surface's viewport-bounded natural
size. A shared bounded position-try fallback applies available-side clipping
only after overflow, so an empty side cannot falsely fit an empty positioning
box. The positioned box follows the Surface's actual bounds; tall content
scrolls inside the Surface body. Every Popover uses this same sizing contract.

Every Popover resolves its layer host once on show from the origin: the
containing active modal dialog, otherwise its normal root. A Solid Portal owns
that mount without duplicating the panel or its state. Native triggers enter the
same show path after native button activation. The popover Escape layer outranks
a containing Dialog; isolated consumers without a keyboard dispatcher use the
same close owner. Dismissal, owner teardown and removal of the active Portal
host release captured references and command-menu state. Preview lifetime
includes both the trigger and the portalled panel.

Session tabs, breadcrumb chips (including folded chips) and Sessions rows
declare one `session` kind with captured sidecar/session/directory/title data.
Existing navigation and approval command owners provide Open, Pin as task/Open
as task, Auto-approve and Copy session title. ProjectTabs contributes available
one `task.add` contribution with stable-keyed destination items through its
captured project/task ports, plus Rename task and Close task for task tabs. The
shared session command owner projects transitions against the currently shown
sidecar/session: Open is absent for that session in every view. Pin as task
remains for an ungrouped current session; an already-grouped current session has
no task-opening item. Background grouped sessions offer Open as task, using the
same guarded navigation and task owner. Ordinary visible-control reselection
remains available independently of context projection. `session.close`
contributes Close session to every session target and the command palette. The
navigation owner removes explicit task membership through the single-member
operation, releases the tab view and returns helpers to their immediate parent.
Sessions remain in the Sessions panel and backend. Closing working, blocked or
unseen-finished sessions asks for confirmation and retains the mandatory phantom
until idle and seen. Project rows share their existing Mark active / Mark
inactive command with the visible project CommandMenu projection, including
shared invocation and row error feedback. Project/task kinds carry sidecar,
directory and task identities instead of component-specific kinds.

Session targets also carry their title origin (`tab`, `chip` or `row`). The
session-action command owner contributes Rename when `sessionActions` is
available. Tabs, breadcrumbs and Sessions rows receive the same framework-free
rename owner; only the matching identity/origin renders `TitleEditor` in its
title slot. The native input selects its text, commits on Enter or blur, cancels
on Escape and retains typed text with local feedback on failure. An editing
control uses a non-button frame so the input is never nested inside a button.
The session-action owner also contributes Delete, whose first activation arms a
shared CommandMenu item in attention paint. Its title names working-session
interruption and the helper count. A second activation executes; row-to-row
pointer/focus movement, Tab and dismissal disarm it. Generic Menu owns row
transitions; CommandMenu owns confirmation state and prevents concurrent
execution. The shell passes deletion to the shared client view-release owner.
The guard's draft-survival input asks only when a stored draft would be lost;
Close keeps ordinary drafts, while successful native deletion drops the family
drafts.

The session-action owner also contributes Fork session to session targets and
the palette, and Fork from here to completed replies. `MessageActions` renders
available command IDs only, sharing `hoverIntent` with Popover (500ms rest,
150ms leave, immediate focus). Prompt Copy and reply Fork/Copy reserve their
metadata-row space while concealed. Message contributes no commands; the shared
transcript feature owns Copy source projection. Fork results open with a joined
`ComposerNotice` / `ForkNote` above the input; Dismiss and the first successful
submission clear the note through the framework-free client owner.

`registerCompactPrompt` contributes Compact while a root composer with a known
next-prompt model is mounted. The command is shared by that session's context
menu, palette and slash completion; background or cross-server targets do not
list it. After composer readiness it captures `nextSelection` and delegates
through the session-bound client compact port. It preserves the unsent draft and
uses normal server-work progress and session errors, including while queued
behind a reply.

Revert to here uses the same prompt context/hover command and selected-session
client revert owner. Root idle sessions advertise it only with `revert`; queued
prompts and read-only helpers omit it. `RolledBackStrip` replaces the transcript
banner using exactly the same joined `ComposerNotice` frame as ForkNote. Its
local disclosure shows bounded prompt previews, times, Copy and file counts and
the permanence note. Restore conversation is visible outside that disclosure and
uses the same registered action as `/restore` and the palette. Pending and
errors remain in that composer area; rollback takes precedence over the fork
note. Restore requires the separately advertised `restore` capability. No
confirmation is added to the native file/conversation rollback. An independently
advertised `revertCode` capability adds Revert code changes to the same prompt
context menu. It uses the existing selected-session revert owner and remains
hidden on backends without that capability. Session targets similarly offer
Archive or Unarchive only with `sessionArchive`, using authoritative state and
the shared CommandMenu. No overlay, style or local archive store is added.

Primary notice content shares `ComposerNoticeRow`: disclosure, error and fork
facts use one control-height row with the same leading icon slot and
flex-centred content. Error reasons are plain text in that row, not paragraphs
with independent margins or placement. The joined frame remains owned by
ComposerNotice.

Undo previous prompt and Redo share that same client owner through palette
commands and `/undo` / `/redo` aliases. Undo can interrupt root-session work
when the prompt capability is available; the owner waits for idle before
rollback. Helpers omit both actions. Built-in slash discovery, like the Palette,
projects the hub's current availability for every command rather than listing
actions that cannot run. Redo pending state uses the same Restoring presentation
as Restore; the client draft transaction restores the exact untouched pre-revert
draft rather than clearing a selected-view pointer.

`TranscriptContext` registers each `prompt`, `reply`, `code`, `diff` and `tool`
action once, independent of transcript length. Targets carry sidecar/session,
message, part/call and directory identity plus source data. Features can
contribute to these shared kinds without editing Message. The few stateful
actions bind lifetime-owned ports keyed by that identity; source text and DOM
are never retained in that owner map. SessionView selects the feature;
independent consumers can compose the same public provider. Prompt/reply copy
uses the part registry's source projection, including a complete grouped reply;
code copy uses its source, never rendered gutters or highlighted DOM. Diff code
copy uses the new-side hunk under the pointer (old-side text for a deleted
file). Tool features contribute optional `presentation.copy` command/path/paths
sources; the shared frame adds available output and disclosure actions without
dispatching concrete tools. A reply's Show usage breakdown invokes TurnUsage's
existing Popover control and renders its existing usage table. Empty output has
no copy action. All target bindings use callback refs, composing with other refs
through Solid's ref array.

Projects, the right panel and the composer declare shared `projects`, `panel`
and `composer` area kinds. Transcript space declares the existing `session` kind
with captured sidecar/session/directory/title data, so session feature
contributions also appear after message groups. Area actions reuse the commands
behind visible controls: Add project, inactive-project disclosure, layout
toggles, session search, agent/model pickers, prompt editor and file picker. The
panel host knows no concrete view: the Sessions component contributes its own
search command while mounted and visible. The sidebar's Search control opens the
command palette; it has no project-search field or separate scan control.

## Semantic themes

Agent colours arrive as neutral hex values or semantic roles. The shared
presentation resolver maps roles into this consumer's theme for reply metadata,
agent triggers and picker rows; native adapters and client state carry no CSS.

`ThemeRegistry` owns immutable data registrations; it imports no themes. A
consumer calls `registerOtkThemes(themes)` to select the shipped complete Dark
and Linen light bases plus Stone, or supplies its own complete mode bases with
`themes.register(data, { base: true })`. Partial registrations inherit missing
slots from their own mode's base. `system` resolves the registered OS-mode base;
an injected registered light-theme identity can select System's light palette.
Unavailable or dark identities fall back to the light base without rewriting the
stored preference. No custom palette ships in OTK. An uninstalled theme ID falls
back to the registered dark base at resolution; the engine retains the
authoritative stored ID, including through previews.

`ThemeEngine(themes, browserThemeEnvironment(), committedId)` is the single
document paint owner. Call `start()` before mounting and release its returned
listener cleanup on application teardown. It applies semantic `--otk-*` slots,
native `color-scheme` and browser `theme-color`; System follows media changes
live. The consumer calls `commit(id)` only from authoritative preference state.
`commit(id, systemLightTheme)` updates both authoritative preferences together.
`preview()` returns an owner-scoped select/close port; close always restores the
latest commit, including a concurrent host broadcast. The engine owns no
storage. `ThemePicker` injects this engine, readiness, async save and close
callbacks and registers its actions in the public command hub. Its content flows
inside the shared Dialog; preview cleanup restores the latest committed paint.

OTK preserves its anthracite Dark default and Phosphor Orange identity. Linen
(`otk-light`, default System light) uses warm beige, Stone (`otk-light-stone`)
uses warm grey. The feature-owned `systemLightTheme` preference is edited in the
theme picker and follows the serving host's persistence/broadcast flow. Primary
fills remain `#ff4d00`, with contrast-safe CTA labels and separate
accent-text/focus slots. Existing CSS names are aliases, not another palette.
Shiki's genuine css-variable token categories alias semantic code slots;
categories shared by Shiki retain their shared mapping (constant includes
numbers/types; foreground covers variables). Switching only changes paint, never
source, grammar, worker lifecycle or cache. Hosts must select/apply a theme; the
UI provider does not install concrete data.

`StatusLight` takes a state (`blocked`, `working`, `finished`, `none`), optional
small sizing and an event identity. Rows use 10px marbles, small lights 8px;
working breathes only its glow in a slow 2.6-second eased cycle, while its
marble body stays steady; a new event blinks once. Accessible labels and native
tooltips accompany every state. The four semantic `lamp-*` theme slots paint
needs-you red, unseen-finished amber, working green and no-evidence grey.
`theme.css` exposes shared `--status-light-*` aliases; the component owns only
construction: radial top highlight, colour-mixed dark rim and glow. Each theme's
gel colours meet 3:1 non-text contrast across base, hover and selected surfaces.
`sessionLight` renders the server supervision projection, never legacy session
status. There is no idle or unknown lamp state. `LIGHT_STATES` owns the public
state inventory and `LightState` derives from its keys; galleries enumerate that
mapping instead of maintaining a second inventory.

The shell's `AttentionProvider` binds the shared client grace owner to accepted
permission evidence/content and system reduced motion plus Animations off.
Composer permission takeovers wait 500 ms; scoped session, family and project
lamps stay immediate unless reduced motion is active, when they retain their
previous state until that same request deadline. Other input stays immediate.
Neither takeovers nor lamps install grace timers. `presentedOnScreen` keeps
reserving the request for its one presentation throughout grace.

Connection health uses `ConnectionLight` and its own connected, connecting,
reconnecting, disconnected and error states. Its pure `connectionState`
projection requires both the serving transport and agent link to be connected
for green; authentication/setup/protocol failures and reported errors are red.
Four `connection-*` theme slots paint quiet discs/rings, independently of
session attention lamps. The flat, steady health disc/ring stays distinct from
the glossy working marble and its breathing halo, even though both use green.
Sidebar column/rail, legacy server listing and Settings use this same component;
reduced colours exposes connection-owned glyphs and descriptions.
`ActivityIndicator` owns the neutral tool/thinking spinner, without a session
state input. It retains reduced-colour and reduced-motion support.

`paintVisualPreferences` paints authoritative `reducedColors` / `animationsOff`
preferences supplied by the consumer; `VisualSettings` takes those preferences,
readiness and an async setter. These settings are contributed by their shared
protocol feature. Reduced colours replaces lamps with shapes and supplies
`.otk-age-0` through `.otk-age-3` underline styles; the action accent is mixed
towards content. Animations off and OS reduced motion suppress all component
animation and transitions, including breathing and event blink.

## Notification channels

Consumers select `registerToastChannel`, `registerOsChannel`,
`registerSoundChannel` and `registerBadgeChannel` against their injected public
client hub. Registrations own their presentation and teardown; they import no
application, RPC implementation or native backend. `Toasts` renders the returned
toast model: information/done chips expire after six seconds, keyed input chips
are active and errors sticky. Toast owns a non-scrolling Surface body. The
viewport-fitted stack shows at most three cards, newest first, and delegates its
overflow row to an injected Sessions-opening callback. Opening that view
detaches the stack so it cannot cover the session lamps. Each card has a square
top-right close slot and a trailing Dismiss action. Both dismiss presentation;
action buttons use delivery-scoped public command IDs. Permission details use
the shared summary's compact, single-line target with the full text in its
title. Session activity labels and stale-resume descriptions come from the
client formatter. Attention is cleared by actual viewing/resolution, not by
dismissal or command promise completion.

The OS channel uses secure-context browser `Notification`, tag replacement,
silent OS presentation and a focus/default-command click handler. `request`
invokes actual browser permission from the opt-in gesture; denied and
unavailable states are exposed separately from host preferences.
Construction/presentation failure reports unavailable to the hub's injected
fallback. `NotificationSettings` injects prefs, readiness, permission status and
async setters; no storage is owned here. The sound channel unlocks on trusted
input and schedules distinct done/input Web Audio tones without assets or
deferred queues. Badge owns a theme-aware SVG favicon counting attention roots,
restores the original on teardown and repaints with semantic theme changes.
