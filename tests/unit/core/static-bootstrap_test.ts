// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { staticResponse } from "../../../core/http/static.ts";
import { clientRequestPolicy } from "../../../core/config/schema.ts";
import { cfg } from "../../support/config.ts";
import { tempDir, test } from "../../support/resources.ts";

test("HTML bootstrap supplies only the serving application's actual safe request policy", async () => {
  const root = await tempDir("static-policy-"), settings = cfg();
  settings.connection.retrybase = 123;
  settings.connection.retrymax = 456;
  settings.auth.password = "synthetic-not-for-the-page";
  await Deno.writeTextFile(
    root + "/index.html",
    "<html><head></head><body>App</body></html>",
  );
  const response = await staticResponse(
    "/mounted/project",
    { staticRoot: root, cfg: settings } as
      & Parameters<typeof staticResponse>[1]
      & { cfg: typeof settings },
  );
  const text = await response.text();
  const tag = text.match(
    /<script type="application\/json" id="otk-bootstrap">([^<]+)<\/script>/,
  );
  assert(tag, "Bootstrap policy must exist before the first connection read");
  assertEquals(JSON.parse(tag[1]), { policy: clientRequestPolicy(settings) });
  assert(!text.includes("synthetic-not-for-the-page"));
  assertEquals(text.match(/id="otk-bootstrap"/g)?.length, 1);
});
