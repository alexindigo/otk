// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { Client } from "../client.ts";
import { models } from "../models.ts";
import { agentColors, agents } from "../agents.ts";
import { sessionDirectory } from "../directory.ts";
import { mapMessage } from "../map.ts";

const settings = {
  url: "http://native.invalid",
  username: "opencode",
  password: "",
  db: "",
  heartbeattimeout: 25,
  reconnectmax: 30,
};
const directory = sessionDirectory(() => "/project", () => {
  throw new Error("Cached directory should be used");
});
const secret = "native-private-value";
function model(id: string, status = "active", input = 0) {
  return {
    id,
    name: `Name ${id}`,
    status,
    cost: { input, output: 0, cache: { read: 0, write: 0 } },
    release_date: "2026-10-17",
    variants: { low: { reasoningEffort: "low", token: secret }, high: {} },
    headers: { Authorization: secret },
    options: { apiKey: secret },
    api: { url: secret },
  };
}
const native = {
  connected: ["opencode", "fake", "no-catalog-entry"],
  default: { opencode: "paid" },
  all: [
    {
      id: "opencode",
      name: "OpenCode",
      key: secret,
      env: [secret],
      options: { headers: { Authorization: secret } },
      models: {
        alpha: model("alpha", "alpha"),
        beta: model("beta", "beta"),
        paid: model("paid", "active", 1),
        old: model("old", "deprecated"),
      },
    },
    {
      id: "fake",
      name: "Local provider",
      models: {
        "family/plain": {
          id: "family/plain",
          name: "Plain",
          status: "active",
          cost: { input: 0 },
        },
      },
    },
    { id: "disconnected", name: "Hidden", models: { hidden: model("hidden") } },
  ],
};

Deno.test("catalog allowlists connected metadata, variants, statuses and opencode-only free pricing", async () => {
  const calls: string[] = [];
  const client = new Client(settings, (input) => {
    const url = new URL(String(input));
    assertEquals(url.searchParams.get("directory"), "/project");
    calls.push(url.pathname);
    return Promise.resolve(
      Response.json(url.pathname === "/provider" ? native : {}),
    );
  });
  const catalog = await models(client, directory).listModels("session");
  assertEquals(calls.sort(), ["/config", "/provider"]);
  assertEquals(catalog, {
    providers: [
      {
        id: "opencode",
        name: "OpenCode",
        models: ["alpha", "beta", "paid", "old"].map((id, index) => ({
          id,
          name: `Name ${id}`,
          variants: ["low", "high"],
          status: (["alpha", "beta", "active", "deprecated"] as const)[index],
          free: id !== "paid",
          releaseDate: "2026-10-17",
        })),
      },
      {
        id: "fake",
        name: "Local provider",
        models: [{
          id: "family/plain",
          name: "Plain",
          variants: [],
          status: "active",
          free: false,
        }],
      },
    ],
  });
  assert(!JSON.stringify(catalog).includes(secret));
  assert(!("default" in catalog));
});

Deno.test("catalog default comes only from config.model present in the connected catalog", async () => {
  for (
    const [configured, expected] of [
      [undefined, undefined],
      ["", undefined],
      ["fake", undefined],
      ["fake/missing", undefined],
      ["disconnected/hidden", undefined],
      ["opencode/paid", { provider: "opencode", model: "paid" }],
      ["fake/family/plain", { provider: "fake", model: "family/plain" }],
    ] as const
  ) {
    const client = new Client(
      settings,
      (input) =>
        Promise.resolve(Response.json(
          new URL(String(input)).pathname === "/provider"
            ? native
            : { model: configured },
        )),
    );
    const catalog = await models(client, directory).listModels("session");
    assertEquals(catalog.default, expected, String(configured));
    assertEquals("default" in catalog, expected !== undefined);
  }
});

Deno.test("catalog resolves each session directory and propagates native errors", async () => {
  const resolved: string[] = [];
  const calls: string[] = [];
  const resolver = sessionDirectory(() => undefined, (id) => {
    resolved.push(id);
    return Promise.resolve({ directory: `/projects/${id}` });
  });
  const client = new Client(settings, (input) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}:${url.searchParams.get("directory")}`);
    return Promise.resolve(
      url.searchParams.get("directory") === "/projects/error"
        ? new Response("catalog unavailable", { status: 503 })
        : Response.json(url.pathname === "/provider" ? native : {}),
    );
  });
  const capability = models(client, resolver);
  await capability.listModels("first");
  await capability.listModels("second");
  await assertRejects(
    () => capability.listModels("error"),
    Error,
    "catalog unavailable",
  );
  assertEquals(resolved, ["first", "second", "error"]);
  for (const id of resolved) {
    assert(calls.includes(`/provider:/projects/${id}`));
    assert(calls.includes(`/config:/projects/${id}`));
  }
});

Deno.test("agent options share transcript color resolution and map only public model and variant metadata", async () => {
  const raw = [
    { name: "build", mode: "primary", color: "primary" },
    { name: "plan", mode: "primary", color: "secondary" },
    {
      name: "review",
      mode: "all",
      description: "Review changes",
      color: "#abcDEF",
      model: { providerID: "fake", modelID: "scripted", private: secret },
      variant: "high",
      prompt: secret,
      options: { token: secret },
    },
    { name: "helper", mode: "subagent", color: "#abc" },
    { name: "invalid", mode: "subagent", color: "url(private)" },
    { name: "hidden", mode: "primary", hidden: true },
  ];
  const client = new Client(settings, (input) => {
    const url = new URL(String(input));
    assertEquals(url.pathname, "/agent");
    assertEquals(url.searchParams.get("directory"), "/project");
    return Promise.resolve(Response.json(raw));
  });
  const capability = agents(client, directory);
  const primary = await capability.listAgents("session", true);
  assertEquals(primary.map((agent) => agent.name), ["build", "plan", "review"]);
  assertEquals(primary[2], {
    name: "review",
    description: "Review changes",
    color: "#abcDEF",
    model: { provider: "fake", model: "scripted" },
    variant: "high",
  });
  const mentions = await capability.listAgents("session");
  assertEquals(mentions.map((agent) => agent.name), [
    "review",
    "helper",
    "invalid",
  ]);
  const colors = await agentColors(client, "/project");
  for (const agent of [...primary, ...mentions]) {
    assertEquals(agent.color, colors.get(agent.name));
  }
  assertEquals(primary[0].color, "var(--accent)");
  assertEquals(primary[1].color, "var(--secondary)");
  assert(!JSON.stringify(primary).includes(secret));
});

Deno.test("user-message mapping lifts native model.variant without adding it to ModelRef", () => {
  for (const variant of [undefined, "high"]) {
    const message = mapMessage({
      id: "message",
      sessionID: "session",
      role: "user",
      time: { created: 1 },
      agent: "build",
      model: { providerID: "fake", modelID: "scripted", variant },
    });
    assert(message.role === "user");
    assertEquals(message.variant, variant);
    assertEquals(message.model, { provider: "fake", model: "scripted" });
  }
});
