// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { parse } from "@std/toml";
import { AuthState, config } from "../../../core/mod.ts";
import { test } from "../../support/resources.ts";
import { cfg, defaultsPath, fixture } from "./support.ts";

for (const failure of ["write", "sync"] as const) {
  test(`auth ${failure} failure never publishes partial identity and permits retry and restart`, async () => {
    const settings = cfg();
    settings.state.path = join(await fixture(), "auth");
    const auth = new AuthState(settings), open = Deno.open;
    Deno.open = async (path, options) => {
      const file = await open(path, options);
      if (options?.createNew && options.write) {
        if (failure === "write") {
          const write = file.write.bind(file);
          file.write = async (bytes) => {
            await write(bytes.subarray(0, 7));
            throw new Error("injected write failure");
          };
        } else {file.sync = () =>
            Promise.reject(new Error("injected sync failure"));}
      }
      return file;
    };
    try {
      await assertRejects(
        () => auth.setup({ type: "none" }),
        Error,
        `injected ${failure} failure`,
      );
    } finally {
      Deno.open = open;
    }
    assert(auth.setupRequired);
    await assertRejects(
      () => Deno.stat(join(settings.state.path, "auth.toml")),
      Deno.errors.NotFound,
    );
    assertEquals(Array.from(Deno.readDirSync(settings.state.path)), []);
    await auth.setup({ type: "none" });
    const stored = parse(
      await Deno.readTextFile(join(settings.state.path, "auth.toml")),
    );
    assertEquals(stored.type, "none");
    assertEquals(settings.auth.secretkey, stored.secretkey);
    const restarted = new AuthState(
      config({ defaultsPath, env: { OTK_STATE_PATH: settings.state.path } }),
    );
    assertEquals(restarted.setupRequired, false);
    assertEquals(restarted.cfg.auth.secretkey, stored.secretkey);
    assertEquals(
      (await Deno.stat(join(settings.state.path, "auth.toml"))).mode! & 0o777,
      0o600,
    );
  });
}

test("competing auth setup publishes exactly one complete identity without overwriting the winner", async () => {
  const path = join(await fixture(), "auth");
  const configs = [cfg(), cfg()];
  for (const config of configs) config.state.path = path;
  const owners = configs.map((config) => new AuthState(config));
  const outcomes = await Promise.allSettled(
    owners.map((owner, i) =>
      owner.setup({ type: "none", username: `owner${i}` })
    ),
  );
  assertEquals(
    outcomes.filter((outcome) => outcome.status === "fulfilled").length,
    1,
  );
  const winner = outcomes.findIndex((outcome) =>
    outcome.status === "fulfilled"
  );
  const stored = parse(await Deno.readTextFile(join(path, "auth.toml")));
  assertEquals(stored.secretkey, configs[winner].auth.secretkey);
  assertEquals(stored.username, `owner${winner}`);
  assertEquals(Array.from(Deno.readDirSync(path)).map((entry) => entry.name), [
    "auth.toml",
  ]);
  await assertRejects(
    () => owners[1 - winner].setup({ type: "none" }),
    Error,
    "already_configured",
  );
  assertEquals(parse(await Deno.readTextFile(join(path, "auth.toml"))), stored);
});

test("failed no-overwrite auth publication leaves setup retryable without a final or staging file", async () => {
  const settings = cfg();
  settings.state.path = join(await fixture(), "auth");
  const auth = new AuthState(settings), link = Deno.link;
  Deno.link = () => Promise.reject(new Error("injected publication failure"));
  try {
    await assertRejects(
      () => auth.setup({ type: "none" }),
      Error,
      "injected publication failure",
    );
  } finally {
    Deno.link = link;
  }
  assert(auth.setupRequired);
  assertEquals(Array.from(Deno.readDirSync(settings.state.path)), []);
  await auth.setup({ type: "none" });
  const restarted = new AuthState(
    config({ defaultsPath, env: { OTK_STATE_PATH: settings.state.path } }),
  );
  assertEquals(restarted.cfg.auth.secretkey, settings.auth.secretkey);
  assertEquals(restarted.setupRequired, false);
});
