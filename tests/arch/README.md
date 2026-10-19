# Kit dependency architecture

Overlay registrations provide content only: DialogHost supplies the native
Dialog, and only overlay specialisations import the internal Surface boundary.
Takeover is the composer-replacement Surface specialisation; its boundary is
checked alongside dialogs, popovers, menus and toasts. Negative fixtures reject
native-dialog/popover bypasses, duplicate card paint, fieldset or legend cards
and positioned overlay content, following registered components and anchored
content dependencies. Overlay placement, resizers and the toast stack remain
outside content. Selection has no exception: its shared binding owns the state
class and ARIA attributes, and its pointer and inset underline are
always-present in-flow pseudo-elements. Architecture negatives reject
hand-written state, attribute-driven paint and positioned selection decoration
across all UI consumers. Every CSS variable must resolve to a theme slot or a
declared structural/component token. Browser checks measure the Display title in
Dark/Linen/Stone, every registered dialog and menu's padded flow, one heading
per dialog, native dismissal, focus return and existing actions.

ListPicker content follows the same recursive Surface/normal-flow checks. Its
architecture gate requires Popover, shared selection and SelectionContent, and
rejects networking, persistence and parent-DOM reach-through. Prompt consumes
generic footer/projection contributions and forwards one captured selection to
normal and feature submit paths. The selection binding also owns independent
highlight classes; browser picker tests measure footer centrelines and selected
pointer geometry, including while another row is highlighted. The composer
client owner holds resource lifecycles, connection generations, cycles and
serialized preference intents. Negatives reject those implementations and
model-key decoding in UI adapters. Browser checks cover lazy closed DOM,
mode-aware shell output, post-readiness snapshots, repeated arrows, leading-edge
anchoring, label/icon centrelines and the action's inclusion in the selected
row. The session supplies one framework-free model-catalog owner to both the
composer and context meter; consumers borrow its loading/error/last-good state
and in-flight work. Browser tests count exactly one catalog request per session
open and preserve the existing composer loading/error/retry test unchanged.

Tabs have no menu presentation; task handlers and scoped commands remain
independent of presentation. Project rows reserve visit time and their menu
trigger in a shared flowing trailing cell. Negative fixtures reject tab menus
and positioning or offsets in row content; overlay content has no project-menu
exception. Browser tests measure stable row/cell geometry on hover/focus and
keyboard menu access. Task outcome tests use the public client owners while the
tab menu is absent; package-local units cover the UI handlers and their captured
project ownership. Those browser drivers return to the UI when replacement
tab-menu wiring is specified.

The visual-system check enforces token-only font selection, minimum 12px text
and the 4px spacing grid across reusable UI styles and application chrome.
Negative fixtures reject direct font selection, undersized text and off-grid
spacing. Theme and contrast tests own palette data and the complete surface
matrix (including alpha compositing, all three themes, hover and selection);
browser tests own constructed lights and accessibility presentation. Lamp paint,
including unlit, belongs only to StatusLight, never theme slots. Selection's
shared pointer/underline CSS contract has unit coverage and real-browser
geometry coverage in full and reduced colours. Selected/current chrome controls
must declare the shared orientation primitive; negative fixtures reject a
selected button that bypasses it. Browser geometry checks span Dark/Linen/Stone,
full/rail, right-open/closed and reduced colours; the two shell corner toggles
retain their bounds and remain hit-testable. Title/navigation assertions follow
the selected breadcrumb; full connection status assertions follow Settings,
which owns that diagnostic presentation.

Both column resizers use the shared immutable pointer-delta gesture owner,
independent of border width or the separator's grab point. Negative fixtures
reject parent-edge coordinate calculations; browser tests observe exact drag
distance, persisted width and reload for both columns.

The shell check enforces implementation-free open dialog/panel/takeover
registries, common typed session ports and absence of per-feature prompt inputs
or shell-built registered dialogs/docks. Negative fixtures reject those boundary
violations. Web's App is public-entry composition only; notification and command
checks follow their new reusable owners. Inbox/browser tests observe the new
column and centre navigation rather than the retired application sidebar. The
right-panel host cannot import or select concrete views or call their RPCs;
negative fixtures enforce that boundary. Registered views own their adapters.
Shell feature availability reads reactive advertised sidecar state, never the
transport's private `supports` query. Negative fixtures reject that bypass;
order-controlled browser tests hold welcome until the direct-route consumer is
mounted and observe permission, question and prompt availability after release
and reload. Existing reconnect coverage preserves unsent attention input.
Session hierarchy/grouping/search remains in the framework-free client owner,
with negative fixtures rejecting duplicate UI or application projections.
Browser drafts likewise belong to client; negative fixtures reject duplicate UI
draft models and concrete attention/tool dispatch in the shared takeover/frame
hosts. Question selections follow the same orientation contract as chrome.
Work-log groups derive from feature-contributed part presentation; negative
fixtures reject concrete tool/reasoning selection in the message or grouping
hosts. Tool owners contribute their summary and initial expansion alongside
their renderer. Browser tests prove the same renderers, draft/late-upload
ownership and backend attention outcomes through the new composer area. Tool
path labels belong to `ToolPath` and the common lexical presenter. The path
architecture check rejects raw path fields/aliases, duplicate path paint,
feature-owned path-list formatting and missing directory inputs in tool/diff
composition. Negative fixtures cover each bypass; browser checks compare header,
body, loaded instruction, working directory and diff paths, including outside
targets and reload. File/grep content stays unchanged inside decoded results
through the shared output owner. The result architecture gate rejects repeated
body operation summaries, per-row count inflection, native-envelope parsing in
the UI and concrete tool dispatch in the shared output renderer. Native format
and fallback tests belong to the adapter; browser tests observe code
highlighting, native gutters, projected match paths and envelope-free bodies
across reload.

Layout controls emit independent field patches, never whole-layout copies from
broadcast-backed props. Negative fixtures reject those stale replacements; the
shell routes intents through the synchronous persisted-state layout RPC owner.
Browser tests hold all gestures in one turn and observe saved fields, rendered
collapse states and restored width after reload. Integration tests cover
separate connections, authoritative broadcasts, invalid-patch atomicity and
restart.

`deno task test:arch` checks the exact seven workspace libraries against the
kit-repackaging dependency table. It also checks root application/core/web/test
consumers for private paths into extracted packages and retired protocol,
harness, store and sidecar application paths. Package metadata must expose only
`mod.ts`; import maps cannot bypass workspace resolution. Protocol production
code cannot acquire external dependencies. Client production code depends only
on protocol, with no Solid imports or legacy networking/reducer escapes; the
standalone consumer imports only `@otk/client`. Solid state storage lives in the
UI library's thin bindings over that client.

The checks cover static imports, type imports, re-exports, side-effect imports
and literal dynamic imports. Uncheckable computed or escaped dependencies are
rejected in package production source. Negative fixtures exercise forbidden
edges and public-entry bypasses, rather than relying only on the current tree
being valid.

Inbox roll-up, visit/ageing and task/phantom/preview projections belong to the
framework-free client owner. Negative fixtures reject duplicate project/tab
model definitions in UI/application source and Solid imports into the models.
Reported context usage and server/project-scoped task mutation ports have the
same ownership; the tab component consumes these public projections and injected
actions rather than calling RPC itself. The ordinary dependency scan applies to
new store/core/client feature files; their standalone public entries remain the
only cross-package boundary.

Tab promotion accepts identity/title/directory metadata rather than requiring a
replicated index row. The shell injects current-input and authoritative-session
ports at the client tab owner; negative fixtures reject status-row-dependent
promotion and a shell binding without those readiness ports. Owner units hold
input delivery deterministically; browser coverage holds real index frames until
the provider reply reaches the transcript, then replays them without loss.

RPC names must derive from the declaration-mergeable protocol `RpcMethods`
interface. Negative fixtures reject closed aliases and extra literal method
names; core RPC tests compile and exercise an external feature contract through
server registration, direct calls and invocation-time selected calls.

Tool and part contracts derive from declaration-mergeable `ToolKinds` and
`PartKinds` interfaces plus separately discriminated external variants. Negative
fixtures reject closed unions, extra union members and closed registry aliases.
Renderer tests exercise feature-owned contracts and name collisions between
typed OTK kinds and external tools/parts; independent browser consumers verify
external rendering and unknown fallbacks.

Preferences compose an open protocol interface from their feature-owned shared
contracts in `packages/protocol/preferences/`. The policy registry imports no
owners; shipped composition selects registration functions, not individual keys.
Defaults and validation derive from contributions. Display menu and commands
consume the same display metadata. Negative fixtures reject central key/default
lists, key-specific registry dispatch, duplicated menu/command lists and closed
theme identities. Contribution tests observe command-driven persistence,
validation and notifications; browser tests observe unknown-theme base paint.

Capability names derive only from protocol's open `CapabilityContracts`, which
composes feature-owned operation contracts. Harness implementations are its
partial map, with no second name list. Negative fixtures reject closed/local
aliases, concrete composition keys, bare string capability surfaces and central
literal lists. A feature-owned extension reaches the real wire and client; typed
consumers reject spelling mistakes and newer wire names remain tolerated.

Native endpoints/schema belong to `@otk/harness-opencode1`. Message collection
storage is separate from the session metadata index: connector/core index fields
cannot create a second `Map<string, IndexEntry>`. Core extends the public
`SessionIndex` owner and injects it through the sink; a native test changes the
core's metadata and observes the connector's directory/status consumers using
it. Message collection endpoints belong only to its bounded `Messages` reader;
negative fixtures reject bypasses from adapter, sessions, tasks, revert,
directory and new native modules. Point-message reads remain available for
requested content. SQL task projections and API fallback pages are reduced to
summary metadata rather than retained transcripts. Store production code cannot
depend on another OTK package; app preference policy and error types are
injected. Its connection and migration runner cannot import feature modules.
Negative fixtures exercise that separation alongside registry-to-feature checks.
Database upgrades compose feature-owned lists whose versions start independently
at 1, tracked by `(feature, version)`. The runner cannot own concrete feature
names or a global numbered list; SQL numbering is scoped to feature directories.
Only the frozen legacy bridge can read `user_version`, mapping exactly the old
0/1/2 states; no production code advances it. Negative fixtures reject global
version use, old migration IDs and flat runner inputs. Store tests observe fresh
subsets, independent upgrades and preserved data from real legacy SQLite
schemas. OTK's root application/core composes backend, feature registrations and
assets; it is not a separate sidecar/server/app library. Core RPC registry
machinery is implementation-free. HTTP routes remain reflective application
files. Package imports cannot escape into core or root bootstrap. UI part/tool
dispatch uses consumer-selected registries, whose machinery imports no features.
Package tests may use test dependencies, while cross-package imports still use
public names. App-level test support may use native endpoints for stock-server
proofs.

The final composition check covers root server and browser entries, shared
production composition in fixtures, retirement of old extraction directories and
the duplicate subprocess launcher, and the application-owned reflective
catch-all. Both shipped and standalone browser consumers must resolve bare kit
names to the packages' declared public entries, rather than private bundler
seams. Negative fixtures retain checks for all retired paths and forbidden
app/server/sidecar package assumptions.
