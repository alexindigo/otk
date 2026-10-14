# @otk/ui

Reusable Solid **2.0.0-rc.13** components, isolated feature registries, syntax
rendering and thin Solid bindings over `@otk/client`. The only OTK dependencies
are the public protocol and client entries. This library has no application/core
imports and knows no native backend.

## Composition and API

Import from `@otk/ui`. `createUiRegistries()` creates empty `tools`, `parts`,
`prompt` and `docks` collections. Choose feature-owned `register*` functions in
your composition root, then provide the collection through `UiProvider`.
Registration rejects duplicate IDs; distinct consumers have independent
collections. Register before mounting. Registries import no implementations.

`tools.register(name, Component)` receives `ToolProps`: the live protocol call,
display preferences, width, directory, waiting state and an injected child-open
callback. Generic protocol tools resolve by their external `name`; unmatched
calls use the fallback installed by `registerGenericTool`. `ToolLine` owns the
shared status/permission/error frame, so external renderers receive the same
behavior. Typed tool modules additionally supply an acceptance predicate, so a
generic call sharing a built-in name cannot enter a renderer for a different
wire shape. `parts.register(kind, Component)` receives `PartProps`;
`registerUnknownPart` supplies unsupported-part fallback.

`prompt.register({ id, create(context) })` installs a per-prompt feature.
`PromptContext` injects data, callbacks, selection/caret/focus operations, an
active-lifetime check and error reporting. Features can provide triggers and
autocomplete sources, key handling, paste/drop, submission transforms,
completion hooks, chips, actions and overlays. Shell, mentions, slash, history,
paste, attachments and editor each own their implementation. `Prompt` owns
native input, submission identity and teardown; it has no feature import list.

`docks.register({ id, capability, render(inputs) })` selects
capability-available injected content by ID. `SessionView` supplies the
data/callback-composed dock slots to `Docks`, preserving mounted dirty state
during transport reconnects. The consumer owns draft/navigation/RPC operations;
children only execute the callbacks they receive.

`createIndex`, `createSession`, `createSidecars` and `solidState` bind the
framework-free client models to Solid stores. Connection options, including the
local API base, are supplied by the consumer; package URLs are never used to
discover an application's address.

`Blocks`, `Code`, `Diff`, `Message`, `ToolLine`, `ToolFrame`, `ToolOutput`,
`Prompt`, `SessionView`, `Sidebar`, `Settings`, `Login`, `Setup`, dock and
display components are independently reusable. The shared highlighting worker
owns its existing bounded cache/capture lifetime; consumers inject all
navigation. Its TextMate metadata and WASM asset use Shiki's public `textmate`
and `onig.wasm` exports. Asset-aware bundling resolves the literal dependency
URL; the worker fetches the same pinned binary into worker-owned complete bytes.
The accepted initialization callback constructs `WebAssembly.Module` and
`WebAssembly.Instance` synchronously in that worker, preserving immediate
termination without an asynchronous streaming validator or persistent cache.
Native Deno module workers resolve that same public export with
`import.meta.resolve`, so direct workers also avoid consumer install paths.

## Example

[`example.tsx`](./example.tsx) renders a generic tool with only the selected
fallback. An application can add `ui.tools.register("my-tool", MyTool)` without
editing this package or a dispatcher. `tests/reuse/custom-tool_test.ts` drives
an independent public-entry browser consumer with custom tool, part, prompt and
dock registrations and verifies rendered updates, callbacks and isolation.

Theme tokens and base controls are loaded with the UI provider. Components
import their own CSS using `with { type: "text" }`: Deno's stable asset
attribute validates the publication graph while Vite bundles the same styles
normally; no CSS loader plugin or generated style mirror is needed. The shipped
terminal identity is unchanged: IBM Plex Mono, `#1a1c1e` background, `#e0e6ed`
foreground and `#ff4d00` accent; fonts are supplied by the consumer. Flex/grid
alignment, source selection and code geometry retain their existing contracts.
No visual redesign is included.

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
No custom palette ships in OTK.

`ThemeEngine(themes, browserThemeEnvironment(), committedId)` is the single
document paint owner. Call `start()` before mounting and release its returned
listener cleanup on application teardown. It applies semantic `--otk-*` slots,
native `color-scheme` and browser `theme-color`; System follows media changes
live. The consumer calls `commit(id)` only from authoritative preference state.
`preview()` returns an owner-scoped select/close port; close always restores the
latest commit, including a concurrent host broadcast. The engine owns no
storage. `ThemePicker` injects this engine, readiness, async save and close
callbacks, owns dialog CSS and registers its actions in the public command hub.

OTK preserves its existing Dark default, font, geometry and Phosphor Orange
identity. Light uses cool white surfaces and dark ink; orange marks remain
`#ff4d00`, while small accent text uses a contrast-safe orange ink slot.
Existing CSS names are aliases, not another palette. Shiki's genuine
css-variable token categories alias semantic code slots; categories shared by
Shiki retain their shared mapping (constant includes numbers/types; foreground
covers variables). Switching only changes paint, never source, grammar, worker
lifecycle or cache. Hosts must select/apply a theme; the UI provider does not
install concrete data.
