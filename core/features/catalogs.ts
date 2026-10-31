// SPDX-License-Identifier: LGPL-3.0-only
import { type Harness, HarnessError } from "@otk/harness";
import type {
  CatalogChunkKinds,
  CatalogCodec,
  CatalogCodecs,
  DirectoryCatalog,
  DirectoryCatalogKinds,
  ServerFrame,
} from "@otk/protocol";
import type { RpcRegistry } from "../ws/registry.ts";
import { text } from "../ws/params.ts";
import { projectPath } from "./project-scan.ts";
import { readExecution } from "../requests/policies.ts";
export { createCatalogCodecs } from "@otk/protocol";
type Kind = keyof DirectoryCatalogKinds & keyof CatalogChunkKinds;
/** Feature-owned wire projection; acquisition remains the harness's directory owner. */
export function registerCatalogs(
  rpc: RpcRegistry,
  harness: Harness,
  codecs: CatalogCodecs,
  rows: number,
): void {
  const port = harness.capabilities.catalogs;
  if (!port) return;
  rpc.register("catalogs.watch", {
    execution: {
      kind: "lease",
      lifetime: "request",
      scope: (directory: string) => ({ directory }),
      receipt: () => undefined,
      recover: () => Promise.resolve({ state: "reload" }),
    },
    params: (p) => projectPath(text(p, "directory")!),
    async handler(ctx, directory) {
      const request = ctx.request;
      if (!request || request.signal.aborted || !request.publish) {
        throw new HarnessError(
          "request",
          "Catalog watch requires a live connection",
        );
      }
      const publish = request.publish;
      let current: DirectoryCatalog | undefined;
      const versions = new Map<Kind, number>();
      const emitKind = <K extends Kind>(catalog: DirectoryCatalog, kind: K) => {
        const value = catalog.values[kind], before = current?.values[kind];
        if (
          value?.state !== "ready" || value.value === undefined ||
          (current?.generation === catalog.generation &&
            before?.revision === value.revision && before.state === value.state)
        ) return;
        const codec = codecs[kind] as CatalogCodec<K> | undefined;
        if (!codec) throw new Error("Missing selected catalog codec");
        const transfer = crypto.randomUUID(),
          iterator = codec.chunks(value.value, rows)[Symbol.iterator]();
        let part = 0, chunk = iterator.next();
        while (!chunk.done) {
          const next = iterator.next();
          publish(
            {
              t: "catalog.chunk",
              directory,
              generation: catalog.generation,
              revision: catalog.revision,
              transfer,
              kind,
              part: part++,
              last: !!next.done,
              items: chunk.value,
            } as ServerFrame,
          );
          chunk = next;
        }
      };
      const metadata = (catalog: DirectoryCatalog): DirectoryCatalog => ({
        ...catalog,
        values: Object.fromEntries(
          Object.entries(catalog.values).map(([kind, value]) => {
            const before = current?.values[kind as Kind];
            if (
              current?.generation !== catalog.generation ||
              before?.revision !== value.revision ||
              before?.state !== value.state
            ) versions.set(kind as Kind, catalog.revision);
            return [kind, {
              state: value.state === "ready" &&
                  !(current?.generation === catalog.generation &&
                    current.values[kind as Kind]?.revision === value.revision &&
                    current.values[kind as Kind]?.state === "ready")
                ? "digesting"
                : value.state,
              revision: versions.get(kind as Kind) ?? catalog.revision,
              ...(value.failure ? { failure: value.failure } : {}),
            }];
          }),
        ),
      });
      const value = await port.watch(directory, (catalog) => {
        if (request.signal.aborted) return;
        publish({ t: "catalog.snapshot", catalog: metadata(catalog) });
        for (const kind of Object.keys(catalog.values) as Kind[]) {
          emitKind(catalog, kind);
        }
        current = catalog;
      }, request.signal);
      return metadata(value);
    },
  });
  rpc.register("catalogs.refresh", {
    execution: readExecution((directory: string) => ({ directory })),
    params: (p) => projectPath(text(p, "directory")!),
    handler: async (ctx, directory) => {
      await port.refresh(directory, ctx.execution?.signal);
      return null;
    },
  });
}
