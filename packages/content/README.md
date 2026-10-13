# @otk/content

Harness-neutral conversion of markdown and unified patches into OTK protocol
shapes, incremental markdown reparsing and authoritative unfinished reply
buffers. No harness, sidecar, database, browser or UI is needed. OTK package
dependencies point only to `@otk/protocol`; parsing uses Marked 17.0.6 and diff
8.0.4.

## Public API

Import only `@otk/content`; `mod.ts` is the single public entry point. Output
types such as `Block`, `FileDiff`, `Message` and `ContentOp` belong to
`@otk/protocol`.

| API                                                     | Purpose                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `markdown(text)`                                        | Convert GFM markdown into `Block[]`; HTML remains plain text                                |
| `lex(text, links?)`, `blocks(tokens)`, `inline(tokens)` | Convert Marked tokens and retain reference definitions                                      |
| `parseDiff(patch)`                                      | Convert unified patches to `FileDiff[]` with status, counts and numbered hunk lines         |
| `StreamingMarkdown`                                     | Append or replace raw text and flush a `{ from, blocks }` suffix, retaining stable prefixes |
| `StreamBuffers`                                         | Own unfinished text and reply clocks across subscriptions, snapshots, replay and completion |

Apply a streaming flush by replacing the block array from `from`, not by
appending the returned blocks. `StreamBuffers` coalesces subscribed deltas at 50
ms, retains unobserved source and emits final authoritative content on
completion. Consumers supply `(sessionID, event)` callbacks; call `stop()` to
release buffers, clocks, subscriptions and pending timers.

## Example

Within the OTK workspace, Deno resolves the package by its name:

```ts
import { markdown, parseDiff, StreamingMarkdown } from "@otk/content";

const heading = markdown("# Reusable content\n");
const files = parseDiff(
  "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
);
const stream = new StreamingMarkdown("# Reusable content\n\n");
stream.append("A streamed paragraph.");
const update = stream.flush();
console.log(heading, files[0].hunks, update);
```

Outside this workspace, map `@otk/content` and `@otk/protocol` to their local
checkout `mod.ts` files in your Deno imports, and preserve the parser dependency
mappings above. Packages are prepared for publication but have not been
published to JSR.

Run `deno task check` and `deno task test` in this directory. Workspace
`deno task test:unit` includes these package tests; `deno task test:reuse` also
exercises a standalone markdown/patch consumer through the public entry.

License: LGPL-3.0-only; see [LICENSE](./LICENSE). Source files retain their SPDX
headers.
