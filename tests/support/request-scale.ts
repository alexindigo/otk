// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { start } from "../../main.ts";
import { cfg } from "./config.ts";
import { FakeLlm } from "./fake-llm.ts";
import { freePort } from "./opencode.ts";
import { resources, tempDir } from "./resources.ts";
import { SCALE } from "./session-scale.ts";
import { createScale, scaleDiscovery } from "./scale-native.ts";
import { servingProbe } from "./serving-probe.ts";

/** Reuse the characterized stock-native population, not a second scale generator. */
export async function requestScaleFixture() {
  const root = await tempDir("rs-"), fake = new FakeLlm();
  const native = await createScale(join(root, "fixture"), root, fake);
  await scaleDiscovery(native);
  assertEquals(native.manifest.counts, SCALE);
  const config = cfg();
  config.server.port = freePort();
  config.auth.type = "none";
  config.state.path = join(root, "otk");
  config.harness.url = native.url;
  config.harness.db = native.db;
  const probe = servingProbe();
  resources().defer("request scale measurements", () => probe.stop());
  const app = await start(config, {
    admission: probe.start,
    section: probe.section,
  });
  resources().defer("request scale application", () => app.stop());
  // Rule 1 no longer catalogs the population at startup. Validate the actual
  // requested identity; the fixture manifest still proves the full population.
  const selected = native.manifest.sessions[0];
  assertEquals(await app.backend.core.identities([selected.id]), [{
    id: selected.id,
    directory: selected.directory,
  }]);
  resources().evidence(
    "request serving samples",
    () =>
      Deno.writeTextFile(
        join(root, "request-scale-samples.json"),
        JSON.stringify({ counts: SCALE, samples: probe.samples }, null, 2),
      ),
  );
  return {
    root,
    native,
    app,
    url: `http://127.0.0.1:${config.server.port}`,
    probe,
  };
}
