// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { DirectoryCatalogs } from "../catalogs.ts";
import type { ProviderReadPort } from "@otk/harness";
Deno.test("retaining agent decoration does not retain file discovery demand", async () => {
  let closed = 0;
  let end!: () => void;
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const catalogs = new DirectoryCatalogs(
    {
      read: () => Promise.resolve([]),
      release() {},
    } as unknown as ProviderReadPort,
    {
      pending: 8,
      contributions: {
        agents: () => Promise.resolve([]),
        files: () => Promise.resolve([]),
      },
      watch: () =>
        ({
          close() {
            closed++;
            end();
          },
          [Symbol.dispose]() {},
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                ended.then(() => ({ done: true as const, value: undefined })),
            };
          },
        }) as Deno.FsWatcher,
    },
  );
  const colors = catalogs.acquire("/p"), files = catalogs.acquire("/p");
  await colors.get("agents");
  await files.get("files");
  files.release();
  assertEquals(closed, 1);
  assertEquals(colors.snapshot().values.files?.value, undefined);
  colors.release();
  await catalogs.stop();
});
