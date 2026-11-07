# Load contracts

`@load` varies 200/4000 unrelated nonempty sessions and 10/130 discovered
projects while keeping one selected session and a 1280x800 viewport. It observes
the browser's first 30 seconds and native startup plus that browser window.
Browser method counts and non-catalog native endpoint counts must be equal
across populations. Catalog endpoint counts and their aggregate share fixed
ceilings. Unrelated-session RPCs, including batched scope identities, and
discovered-directory native reads are zero. Index entries contain only the
leased session; every project has one keyed summary.

The native catalog ceiling is independent of observed counts: seven shipped
catalog codecs (`packages/protocol/catalogs/codecs.ts`) x five owner acquisition
or refresh sources = 35 per endpoint at either population. Those sources are
initial lease acquisition, native-instance reset, and `catalog.updated`,
`integration.updated`, `reference.updated` in
`packages/harness-opencode-v1/catalogs.ts`. This fixed startup budget
accommodates coalescing/preemption order within the shared catalog acquisition
set; it is not a bound for arbitrary later user refreshes, edits or reconnects.
The eight native catalog endpoint families in `catalog-reads.ts` share the
aggregate ceiling 8 x 35 = 280 at both population sizes. Neither ceiling is
fitted to observations.

The owner already joins per-kind in-flight work and repeats reads after dirty
invalidation; revocable native I/O can restart after essential preemption. Exact
per-catalog endpoint attempts can therefore drift without growing with
population. The budget is derived from owner composition and refresh sources,
not the measured `/command` or `/question` counts. Priority, idle pause and zero
digest-only projection recomputation are separate permanent contracts in the
same area.
