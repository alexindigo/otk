// SPDX-License-Identifier: LGPL-3.0-only
import type {
  CatalogChunkKinds,
  CatalogCodec,
  DirectoryCatalogKinds,
} from "../catalogs.ts";
type ArrayKind = {
  [K in keyof CatalogChunkKinds & keyof DirectoryCatalogKinds]:
    DirectoryCatalogKinds[K] extends CatalogChunkKinds[K][] ? K : never;
}[keyof CatalogChunkKinds & keyof DirectoryCatalogKinds];
export function arrayCatalogCodec<
  K extends ArrayKind,
>(): CatalogCodec<K> {
  return {
    *chunks(value, rows) {
      const items = value as CatalogChunkKinds[K][];
      for (let at = 0; at < items.length || at === 0; at += rows) {
        yield items.slice(at, at + rows);
      }
    },
    create() {
      const items: CatalogChunkKinds[K][] = [];
      return {
        append: (chunk) => {
          for (const item of chunk) items.push(item);
        },
        finish: () => items as unknown as DirectoryCatalogKinds[K],
      };
    },
  };
}
