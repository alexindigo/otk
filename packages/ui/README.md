# @otk/ui

Reusable Solid **2.0.0-rc.13** components, isolated feature registries, syntax
rendering and thin Solid bindings over `@otk/client`. The only OTK dependencies
are the public protocol and client entries. This library has no application/core
imports and knows no native backend.

## Composition and API

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
argument supplies `{icon, verb, target?, summary?, expanded?}` with the caller's
directory as a second context argument; path-owning features supply relative
targets. Icons accept strings or feature-owned SVG render functions. The shared
frame has no concrete tool list. The path presenter keeps project descendants
relative and outside paths absolute; body labels use `ToolPath` with the same
directory input, including instruction, working-directory and diff labels.
Structured result paths use that presenter inside `ToolOutput`; file contents
use the same `Code` owner as writes, with native first-line numbering and
extension-based highlighting. Grep results carry path, line and text. Custom
tool consumers can import `ToolPath` and `relativeTarget` from the public UI
entry to share the same body and header presentation. Edits/patches/writes and
helper cards start expanded. Typed tool modules use
`tools.registerTyped(kind, Component)`, whose call type derives from the open
protocol `ToolKinds` map. Separate registration namespaces let an external
`edit` coexist with typed OTK `edit` without either renderer receiving the
other's shape. `parts.register(name, Component)` receives an external part;
`parts.registerTyped(kind, Component)` derives its shape from the open
`PartKinds` map. The same namespace separation applies to parts;
`registerUnknownPart` supplies unsupported-part fallback. Part registrations can
contribute `{work?, text?, hidden?}` presentation data: the message groups
adjacent contributed work clocks into expandable folds and copies contributed
source text without dispatching concrete part kinds or reading child DOM. Read,
search, fetch, web search, skill and task bodies render their inherited native
result through the same `ToolOutput` owner as bash. The adapter's decoded
results contain user content and metadata, not model-facing envelopes.
Unrecognized formats retain verbatim fallback. Headers alone summarize
operations; bodies contain results, metadata, diagnostics and
navigation/progress actions. Row count inflection uses the shared count-label
helper. Structural edit, write, patch, todo and question bodies keep their typed
result presentation; generic output retains its display preference and bounded
preview notice. Invisible bookkeeping owners declare themselves hidden so wire
steps cannot split a visible work fold. Reply metadata combines contiguous
source parts for one whole-reply copy.

Unfinished assistant replies end with a thin in-flow glimmer beneath their last
content and before metadata. The grouped reply's completion clock owns its
lifetime, so continued backend steps share one indicator and terminal replies
have none. OS reduced motion and the persisted Animations off preference replace
the shimmer with quiet “response in progress” text between flowing rules. The
same named status remains available to assistive technology in either mode.

`prompt.register({ id, create(context) })` installs a per-prompt feature.
`PromptContext` injects selection/caret/focus operations, an active-lifetime
check, error reporting and `SessionProvider`'s common session ports: typed
`rpc(method, params)`, `supports(capability)`, session ID, directory,
preferences, history, attachment resolution, dirty-state and successful-action
callbacks. There are no per-feature callbacks or capability flags on `Prompt`.
The session `supports` port reads reactive advertised capabilities: an initial
welcome activates already-mounted consumers, and reconnecting retains feature
owners and their unsent input. Transport readiness is a separate input to
actions. Features can provide triggers and autocomplete sources, key handling,
paste/drop, submission transforms, completion hooks, chips, actions and
overlays. Shell, mentions, slash, history, paste, attachments and editor each
own their implementation. `Prompt` owns native input, submission identity and
teardown; it has no feature import list.

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
availability. Explicit picker opening refreshes that same resource; last
successful data survives refresh/errors. Model search groups favourites, recent
and connected providers; star actions and successful normal-prompt recent
recording persist through the serving host's `prefs.set` command. Commands
`model.choose` (Mod+'), `variant.cycle` (Alt+T) and `agent.choose` are
discoverable in the command hub. Without the models capability the model stays
plain text. Shell displays only agent/model, matching its wire projection.
Unknown catalog metadata preserves and displays a restored variant rather than
silently dropping it. Palette-native slash execution shares the same readiness
and projection.

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
prompt focus port. Shared anchoring opens above the leading edge and tries
inline/block flips only for viewport overflow. Footer labels and real chevron
icons share flex centring; trigger accessible names include current values.
Loading/error states do not also report an empty catalog.

Composer model labels show the provider in secondary paint before the model,
including for backend-applied and plain-label states. Full provider/model names
remain in picker tooltips and accessible names when visible text truncates. The
footer gives controls their natural width and shrinks the model control only
under actual row pressure: provider text yields first, then model text. Shared
flex sizing keeps actions on the same row without a fixed label cap. Agent and
variant labels use display-only title case in triggers and menu rows; keys and
submitted values retain their exact spelling. Edit prompt uses the shared 28px
pencil icon button with its accessible name and tooltip.

Backend-applied composer values use the shared `is-applied` trigger state and
`--applied-fg` theme token, with the same text and geometry. The generic trigger
includes its default origin in the accessible name. Explicit/restored choices
remain unmuted. The client supplies both applied values and selected variant
row; choosing Default can show a configured variant while the Default row
retains its pointer and names that applied value in secondary text.

`takeovers.register({ id, capability, component })` supplies composer attention
owners. `ComposerTakeovers` mounts capability-available components; they read
session state from context and construct their own UI. Optional feature-owned
`active(session)` predicates suspend the ordinary composer while attention owns
its area. The prompt's draft survives the takeover. Permission and question
surfaces replace the composer with a raised, bordered, 20px-radius Takeover and
a common blocked-light header. Consumer-supplied session location names the
project/task; question tabs/options use shared underline/pointer primitives.
Static keyboard hints are in titles, Keys and the palette, not the surface.
Permission and question owners preserve dirty state through reconnects. The
legacy `Docks` API remains independently reusable for existing consumers.

`dialogs.register({ id, title, component })` installs feature-owned dialog
content. A single `DialogHost` handles `dialog.open({ id, input? })` through the
command hub. It returns an identity-bound close handle, so a stale completion or
feature teardown cannot close a replacement dialog. Command, keymap, theme,
editor and add-project features own their registrations. `DialogHost` wraps
every registration in the native `Dialog` owner; optional `commandId` preserves
feature close IDs and `dismiss(input)` routes dismissal through feature state
when needed. Content never creates a second dialog, title or card. The internal
`Surface` owns boundary, paint, padding and title/body/action flow; only
`Dialog`, `Popover`, `Menu`, `Toast` and `Takeover` specialisations may consume
it. `Popover` owns native top-layer anchoring and outside-click/Escape
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

`Shell({ theme, api })` composes the reusable three-region shell with selected
UI registrations. `ProjectInbox` renders the shared client projection in its
column and 48px rail; it does not recompute roll-ups, unread or ageing. Width
(200–360px, 248 default) and collapsed states follow the serving server's
`shellLayout` preference. Controls pass independent `Partial<ShellLayout>` field
intents through `onLayout`; the shell sends `layout.patch`, whose core owner
merges against persisted state before validation/save/broadcast. No control
constructs a whole-layout replacement from props. `ProjectTabs` consumes the
public client tabs model, server/project-scoped task actions and injected
guarded navigation. It renders task/phantom/preview tabs, ordered foldable
breadcrumbs with helper nesting and reported usage, using 8px status lights.
Shell-owned 28px corner toggles stay at a shared 12px offset across full/rail
and right-open/closed layouts; each top bar reserves the corner zone. The 52px
centre bar contains quiet task pills and injected Display options; the
breadcrumb owns the selected session title and path tooltip. Reported usage
fills the context bar against the reporting model's catalog context window;
unknown windows show tokens without an invented denominator or bar. The inbox
has 32px rows, hover-revealed menus, Search and a compact settings/keys/server
footer; Sessions has 30px rows and CSS child guides. Chrome uses the shared
selection pointer/underline, and shortcuts remain in tooltips, Keys and the
palette. `registerTaskDialogs` contributes its name editor to the dialog host.
Tabs have no per-tab menu; their owner-scoped commands and package-internal task
handlers retain pin, naming, moving, adding and closing actions independently of
presentation. Project rows own selection around their flowing open button and
trailing cell. That cell reserves visit time and menu trigger in the same grid
cell, revealing the trigger on hover or focus without shifting content or
positioning it over the row. `session.preview` and `session.pin` are guarded
command ports for the Sessions panel; preview replacement cannot remove required
activity tabs. `ProjectSessions` consumes the framework-free client hierarchy
and injected open/pin/create actions. The shell's existing navigation guard
protects draft/attention input, including same-event slash navigation and
browser history. Project-only URLs support empty projects. Opening or acting
resets visits; a loaded viewed session records seen.

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

## Example

[`example.tsx`](./example.tsx) renders a generic tool with only the selected
fallback. An application can add `ui.tools.register("my-tool", MyTool)` without
editing this package or a dispatcher. `tests/reuse/custom-tool_test.ts` drives
an independent public-entry browser consumer with custom tool, part, prompt and
dock registrations and verifies rendered updates, callbacks and isolation.

Theme tokens and base controls are loaded with the UI provider. Components
import their own CSS using `with { type: "text" }`: Deno's stable asset
attribute validates the publication graph while Vite bundles the same styles
normally; no CSS loader plugin or generated style mirror is needed. Consumers
bundle IBM Plex Sans 400/500/600 and IBM Plex Mono 400/600; all selection uses
`--font-ui` / `--font-mono`. Interface text is 13/20, prose 14/24, headings
16/24 600 and metadata 12px sans; mono is for code, paths, commands and IDs.
Base buttons are ghost controls; `.otk-pill`, `.otk-icon-button` and
`.otk-send-button` provide action pills, 28px icons and 32px circular Send.
Radii use shared role tokens: controls/rows 8px, inline code 5px, cards 10px,
bubbles 18px and composer 20px. Accent is reserved for primary actions and
focus. Source selection and code geometry retain their existing contracts.
Transcript, composer and takeovers share `--lane-width: 736px` (the prototype's
46rem at its default 16px root), centred within 24px gutters independently of
the 13px interface root. User bubbles occupy at most 80% of that lane.

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

Package units live in `tests/`; real browser/app tests remain at repository
level. Builds/tests run inside the project's assigned VM. License: LGPL-3.0-only
(see `LICENSE`).

## Command input and keyboard

`CommandProvider` supplies a public client `CommandHub` and optional
`createKeyboard` dispatcher. Components own their registrations through
`ownedCommand` / isolated `ownedAction`; registration starts at Solid's settled
mount and releases on unmount, so speculative replacement does not overlap a
previous session's actions. Consumers continue to supply data and callbacks.

`makeKeymap` ports kosmozoo's data bindings, canonical modifiers, bare-letter
matching, overrides, conflicts and resets. Bindings contain a command ID, never
an execution callback. `bind(descriptor, when?)` returns an unregister function.
Text fields are protected unless `inPrompt` opts in; `Mod` is Ctrl or Meta on
macOS. `createKeyboard(...).start(document)` owns listeners until the returned
stop function runs. Layers contain close-command IDs, a predicate and priority,
with latest registration breaking ties. Composition and repeat events do not
invoke commands.

`Palette` lists the injected registry; `KeysHelp` lists the injected keymap,
checks overlap conflicts and supplies proposed overrides to `onSave`. Production
OTK uses the host core's ordered `keymap` preference broadcast; failed saves do
not optimistically change bindings. The shared Dialog owns focus return, modal
keyboard priority and styles, including the prompt editor. The essential shipped
bindings are Tab/reverse agent cycle, Enter submission, Mod+K palette,
outside-text `?` help and top-layer Esc before double-Esc interrupt. Shift+Enter
inserts a newline through the prompt-owned input port.

## Semantic themes

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

`StatusLight` takes a state (`blocked`, `working`, `finished`, `idle`), optional
small sizing and an event identity. Rows use 10px marbles, small lights 8px;
working breathes only its glow and a new event blinks once. Accessible labels
and native tooltips accompany every state. Every theme uses the same fixed gel
colours (`#ff2e4d`, `#ff8f2e`, `#30ff85`, idle `#8e949b`), a radial top
highlight and a colour-mixed dark rim. Lamp colours are owned by the component,
not theme slots; their contrast is measured against their own rim.
`sessionLight` maps the existing session index without inventing unread marks;
the caller supplies a finished state when its model has seen information.

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
are active and errors sticky. Message buttons dismiss presentation; action
buttons use delivery-scoped public command IDs. Attention is cleared by actual
viewing/resolution, not by dismissal or command promise completion.

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
