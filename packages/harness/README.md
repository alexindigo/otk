# @otk/harness

Harness-neutral session and lifecycle contracts, `HarnessSink`, `HarnessError`,
and typed optional capabilities. Depends only on `@otk/protocol`. Import the
public entry `@otk/harness`; native schemas and endpoints belong to adapters.

```ts
import {
  CapabilityRegistry,
  type Harness,
  requireCapability,
} from "@otk/harness";

const registry = new CapabilityRegistry();
registry.register("history", {
  listHistory: () => Promise.resolve([]),
  attachment: () => Promise.reject(new Error("No attachment")),
});
console.log(
  await requireCapability(registry.capabilities, "history").listHistory(),
);

async function readChildren(harness: Harness, id: string) {
  return await harness.core.listChildren(id);
}
```

A harness pairs `core` (identity, start/stop, subscriptions, session creation
and queries) with `capabilities`. Prompt/abort, shell, commands, history, files,
agents, resources, permissions, questions and revert are optional. History reads
and attachment retrieval are asynchronous. Consumers check or require a
capability at their operation boundary. Missing and duplicate registrations
raise a `HarnessError` with code `capability`. Registry snapshots are frozen;
the supplied capability objects retain their identity and lifetimes.

The name and operation contract lives in `@otk/protocol`'s open
`CapabilityContracts` interface. This package re-exports its `Capabilities`,
`CapabilityName` and shipped operation types. A feature augments that protocol
interface beside its code; registry registration, `requireCapability`, wire
advertisement and client/UI availability then share the same typed name.

The core owns lifecycle; call `stop()` to release its streams and outstanding
operations. A sink receives connection state, index snapshots/updates/removals,
content operations and resync notifications. Capabilities do not own the sink.

License: LGPL-3.0-only. Workspace validation: `deno task test:unit` and
`deno task test:arch`.
