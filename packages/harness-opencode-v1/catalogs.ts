// SPDX-License-Identifier: LGPL-3.0-only
import {
  DirectoryCatalogs as Catalogs,
  type ProviderReadPort,
} from "@otk/harness";
import type { DirectoryCatalogKinds } from "@otk/protocol";
import type { PendingQuestions } from "./pending-questions.ts";
import type { Envelope } from "./types.ts";
export type { CatalogContributions, CatalogLease } from "@otk/harness";
import type { DirectoryCatalogOptions as CatalogOptions } from "@otk/harness";

const nativeCatalogEvents: Record<
  string,
  readonly (keyof DirectoryCatalogKinds)[]
> = {
  "catalog.updated": ["models"],
  "integration.updated": ["models", "resources", "commands"],
  "reference.updated": ["agents", "commands", "skills", "resources"],
};
export const catalogEventTypes: ReadonlySet<string> = new Set(
  Object.keys(nativeCatalogEvents),
);
export interface DirectoryCatalogOptions extends CatalogOptions {
  questions?: PendingQuestions;
}
/** Native invalidation and pending authority wrap the shared volatile owner. */
export class DirectoryCatalogs extends Catalogs {
  constructor(reads: ProviderReadPort, options: DirectoryCatalogOptions) {
    super(reads, {
      ...options,
      contributions: {
        questions: async (directory, signal, owner) => {
          for (;;) {
            const capture = options.questions?.capture(directory);
            try {
              const value = await reads.read(
                "catalog.questions",
                { directory },
                {
                  owner,
                  priority: "attention",
                  signal,
                },
              );
              signal.throwIfAborted();
              if (!capture) return value;
              if (capture.commit(value)) {
                return options.questions!.directory(directory);
              }
            } finally {
              capture?.release();
            }
          }
        },
        ...options.contributions,
      },
    });
  }
  event(event: Envelope): readonly (keyof DirectoryCatalogKinds)[] | undefined {
    const kinds = nativeCatalogEvents[event.payload.type];
    if (!kinds) return;
    if (event.directory === undefined) this.invalidateAll(kinds);
    else this.invalidate(event.directory, kinds);
    return kinds;
  }
}
