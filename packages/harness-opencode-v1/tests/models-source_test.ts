// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { Client } from "../client.ts";
import { sessionDirectory } from "../directory.ts";
import { models } from "../models.ts";

Deno.test("model catalog acquires connected providers only and keeps the explicit configured default", async () => {
  const calls: string[] = [];
  const client = new Client({
    url: "http://native.invalid",
    username: "opencode",
    password: "",
    db: "",
    heartbeattimeout: 25,
    reconnectmax: 30,
    requestms: 60000,
  }, (input) => {
    const url = new URL(String(input));
    assertEquals(url.searchParams.get("directory"), "/project");
    calls.push(url.pathname);
    if (url.pathname === "/config/providers") {
      return Promise.resolve(Response.json({
        providers: [{
          id: "fake",
          name: "Connected",
          models: {
            "family/model": {
              id: "family/model",
              name: "Chosen model",
              status: "active",
              variants: { high: {} },
            },
            other: {
              id: "other",
              name: "Native provider default",
              status: "active",
            },
          },
        }],
        default: { fake: "other" },
      }));
    }
    if (url.pathname === "/config") {
      return Promise.resolve(Response.json({ model: "fake/family/model" }));
    }
    throw new Error(
      `Catalog must not acquire unrelated native inventory: ${url.pathname}`,
    );
  });
  const directory = sessionDirectory(() => "/project", () => {
    throw new Error("Directory already known");
  });
  const value = await models(client, directory).listModels("opcv1-session");
  assertEquals(calls.sort(), ["/config", "/config/providers"]);
  assertEquals(value, {
    providers: [{
      id: "fake",
      name: "Connected",
      models: [
        {
          id: "family/model",
          name: "Chosen model",
          status: "active",
          variants: ["high"],
          free: false,
        },
        {
          id: "other",
          name: "Native provider default",
          status: "active",
          variants: [],
          free: false,
        },
      ],
    }],
    default: { provider: "fake", model: "family/model" },
  });
});
