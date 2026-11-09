// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertFalse } from "@std/assert";
import { modelCatalogCodec } from "@otk/protocol";
import {
  mapAgents,
  mapCommands,
  mapConfig,
  mapModels,
  mapSkills,
  mergeCommands,
  type NativeAgent,
  type NativeConfig,
  type NativeModel,
  type NativeProvider,
} from "../catalog-readers.ts";

function model(id = "model", cost: NativeModel["cost"] = []): NativeModel {
  return {
    id,
    modelID: id,
    providerID: "provider",
    name: id,
    variants: [{ id: "high", headers: { secret: "do-not-expose" } }],
    status: "active",
    enabled: true,
    cost,
    limit: { context: 200000, output: 10000 },
    time: { released: 1000 },
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    settings: { apiKey: "do-not-expose" },
    headers: { Authorization: "do-not-expose" },
  };
}
const provider: NativeProvider = {
  id: "provider",
  name: "Provider",
  activation: "auto",
  package: "secret-package",
  settings: { apiKey: "do-not-expose" },
};
const config: NativeConfig = [{ type: "directory", path: "/config" }, {
  type: "document",
  path: "/config/opencode.json",
  info: {
    model: { providerID: "provider", model: "model", variant: "high" },
    providers: {
      provider: {
        settings: { apiKey: "do-not-expose" },
        models: { model: { name: "configured" } },
      },
    },
  },
}];
const zero = { input: 0, output: 0, cache: { read: 0, write: 0 } };

Deno.test("V2 catalogs preserve IDs and allowlist metadata instead of native request/config bodies", () => {
  const agents = mapAgents(
    (["primary", "subagent", "all"] as const).map((mode, i) => ({
      id: `id-${i}`,
      name: `Display ${i}`,
      mode,
      hidden: false,
      permissions: [],
      request: { headers: { secret: "do-not-expose" }, settings: {}, body: {} },
      model: { providerID: "provider", id: "model", variant: "high" },
      color: "primary",
    } satisfies NativeAgent)),
  );
  assertEquals(
    agents.map((agent) => [agent.id, agent.name, agent.primary, agent.mention]),
    [["id-0", "Display 0", true, false], ["id-1", "Display 1", false, true], [
      "id-2",
      "Display 2",
      true,
      true,
    ]],
  );
  assertEquals(agents[0].model, { provider: "provider", model: "model" });
  assertEquals(agents[0].variant, "high");
  assertEquals(agents[0].color, "accent");
  assertFalse(JSON.stringify(agents).includes("do-not-expose"));
  const hidden = mapAgents([
    {
      id: "hidden",
      name: "Hidden",
      mode: "all",
      hidden: true,
      color: "#f0a",
      permissions: [],
      request: { headers: {}, settings: {}, body: {} },
    } satisfies NativeAgent,
  ])[0];
  assertFalse(hidden.primary);
  assertFalse(hidden.mention);
  assertEquals(hidden.color, "#f0a");
  assertFalse(JSON.stringify(mapConfig(config)).includes("do-not-expose"));
  assertEquals(mapConfig(config)[1], {
    type: "document",
    path: "/config/opencode.json",
    order: 1,
    model: { provider: "provider", model: "model" },
    variant: "high",
  });
});
Deno.test("V2 model prices keep all tiers, known zero, unknown and applied/configured provenance through chunking", () => {
  const tiered = model("tiered", [zero, {
    ...zero,
    tier: { type: "context", size: 200000 },
    input: 2,
  }]);
  const base = model("model", [zero]);
  const unknown = model("unknown");
  const invalid = model("invalid", [{ ...zero, input: Number.NaN }]);
  const catalog = mapModels(
    [base, tiered, unknown, invalid, { ...model("disabled"), enabled: false }, {
      ...model("image"),
      type: "image",
    }],
    [provider],
    base,
    config,
  );
  const [free, paid, unpriced, bad] = catalog.providers[0].models;
  assertEquals(catalog.defaultState, "configured");
  assertEquals(catalog.defaultVariant, "high");
  assertEquals(free.free, true);
  assertEquals(free.cost, zero);
  assertEquals(paid.free, false);
  assertEquals(paid.cost, undefined);
  assertEquals(paid.costs, tiered.cost);
  assertEquals(unpriced.free, null);
  assertEquals(bad.free, null);
  assertEquals(free.variants, ["high"]);
  assertEquals(free.contextLimit, 200000);
  assertEquals(free.provenance, [{ source: "native" }, {
    source: "configuration",
    path: "/config/opencode.json",
    order: 1,
  }]);
  assertFalse(JSON.stringify(catalog).includes("do-not-expose"));
  assertFalse(JSON.stringify(catalog).includes("secret-package"));
  const decoder = modelCatalogCodec.create();
  for (const chunk of modelCatalogCodec.chunks(catalog, 1)) {
    decoder.append(chunk);
  }
  assertEquals(decoder.finish(), catalog);
  assertEquals(mapModels([base], [provider], base, []).defaultState, "applied");
  assertEquals(
    mapModels([base], [provider], undefined, config).defaultState,
    "unknown",
  );
});
Deno.test("V2 command collisions retain native names and distinct skill identities", () => {
  const commands = mapCommands([{ name: "same", description: "native" }]);
  const skills = mapSkills([{
    id: "skill-id",
    name: "same",
    path: "/skills/same",
    content: "do-not-expose",
  }, {
    id: "other-id",
    name: "Other name",
    path: "/skills/other",
    content: "do-not-expose",
  }]);
  const merged = mergeCommands(commands, skills);
  assertEquals(merged[0], {
    name: "same",
    description: "native",
    aliases: [],
    source: "unknown",
  });
  assertEquals(merged[1].skillID, "other-id");
  assertEquals(merged[1].name, "Other name");
  assert(merged[1].source === "skill");
  assertFalse(JSON.stringify(skills).includes("do-not-expose"));
});
