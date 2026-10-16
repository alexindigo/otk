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
status/permission/error frame, so external renderers receive the same behavior.
Typed tool modules use `tools.registerTyped(kind, Component)`, whose call type
derives from the open protocol `ToolKinds` map. Separate registration namespaces
let an external `edit` coexist with typed OTK `edit` without either renderer
receiving the other's shape. `parts.register(name, Component)` receives an
external part; `parts.registerTyped(kind, Component)` derives its shape from the
open `PartKinds` map. The same namespace separation applies to parts;
`registerUnknownPart` supplies unsupported-part fallback.

`prompt.register({ id, create(context) })` installs a per-prompt feature.
`PromptContext` injects selection/caret/focus operations, an active-lifetime
check, error reporting and `SessionProvider`'s common session ports: typed
`rpc(method, params)`, `supports(capability)`, session ID, directory,
preferences, history, attachment resolution, dirty-state and successful-action
callbacks. There are no per-feature callbacks or capability flags on `Prompt`.
Features can provide triggers and autocomplete sources, key handling,
paste/drop, submission transforms, completion hooks, chips, actions and
overlays. Shell, mentions, slash, history, paste, attachments and editor each
own their implementation. `Prompt` owns native input, submission identity and
teardown; it has no feature import list.

`takeovers.register({ id, capability, component })` supplies composer attention
owners. `ComposerTakeovers` mounts capability-available components; they read
session state from context and construct their own UI. The shipped permission
and question owners preserve dirty state through reconnects. R3 retains their
above-prompt placement; R6 changes their presentation to composer takeovers. The
legacy `Docks` API remains independently reusable for existing consumers.

`dialogs.register({ id, component })` installs a feature-owned dialog. A single
`DialogHost` handles `dialog.open({ id, input? })` through the command hub. It
returns an identity-bound close handle, so a stale completion or feature
teardown cannot close a replacement dialog. Command, keymap, theme, editor and
add-project features own their registrations.
`panels.register({ id, title, icon, capability?,
component })` contributes
right-panel views; R3 provides the empty slot and R5 its view host.

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
`registerTaskDialogs` contributes its name editor to the dialog host.
`session.preview` is the command port for the future Sessions panel; preview
replacement cannot remove required activity tabs. The interim `ProjectSessions`
remains inside Browse sessions until that panel lands. The shell's existing
navigation guard protects draft/attention input, including same-event slash
navigation and browser history. Project-only URLs support empty projects.
Opening or acting resets visits; a loaded viewed session records seen.

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
`--font-ui` / `--font-mono`. Interface text is 13/20, prose 15/24, code 13/20,
with a 12px minimum. Neutral interactions, 4px spacing, 6px controls and 10px
cards share the base visual contract. Accent is reserved for primary actions,
attention controls and focus. Source selection and code geometry retain their
existing contracts.

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
not optimistically change bindings. Components own dialog focus and styles. The
essential shipped bindings are Tab/reverse agent cycle, Enter submission, Mod+K
palette, outside-text `?` help and top-layer Esc before double-Esc interrupt.
Shift+Enter inserts a newline through the prompt-owned input port.

## Semantic themes

`ThemeRegistry` owns immutable data registrations; it imports no themes. A
consumer calls `registerOtkThemes(themes)` to select the shipped complete Dark
and Light bases, or supplies its own complete mode bases with
`themes.register(data, { base: true })`. Partial registrations inherit missing
slots from their own mode's base. `system` resolves the registered OS-mode base.
No custom palette ships in OTK. An uninstalled theme ID falls back to the
registered dark base at resolution; the engine retains the authoritative stored
ID, including through previews.

`ThemeEngine(themes, browserThemeEnvironment(), committedId)` is the single
document paint owner. Call `start()` before mounting and release its returned
listener cleanup on application teardown. It applies semantic `--otk-*` slots,
native `color-scheme` and browser `theme-color`; System follows media changes
live. The consumer calls `commit(id)` only from authoritative preference state.
`preview()` returns an owner-scoped select/close port; close always restores the
latest commit, including a concurrent host broadcast. The engine owns no
storage. `ThemePicker` injects this engine, readiness, async save and close
callbacks, owns dialog CSS and registers its actions in the public command hub.

OTK preserves its Dark default and Phosphor Orange identity. Light uses cool
white surfaces and dark ink; primary fills remain `#ff4d00`, with contrast-safe
CTA labels and separate accent-text/focus slots. Existing CSS names are aliases,
not another palette. Shiki's genuine css-variable token categories alias
semantic code slots; categories shared by Shiki retain their shared mapping
(constant includes numbers/types; foreground covers variables). Switching only
changes paint, never source, grammar, worker lifecycle or cache. Hosts must
select/apply a theme; the UI provider does not install concrete data.

`StatusLight` takes a state (`blocked`, `working`, `finished`, `idle`), optional
small sizing and an event identity. Rows use 10px marbles, small lights 8px;
working breathes only its glow and a new event blinks once. Accessible labels
and native tooltips accompany every state. Both themes use identical gel colours
on a dark socket, with a contrast-checked outer rim. `sessionLight` maps the
existing session index without inventing unread marks; the caller supplies a
finished state when its model has seen information.

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
