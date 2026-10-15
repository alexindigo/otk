// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  createPreferences,
  PreferenceRegistry,
  type Preferences,
} from "@otk/protocol";
import { CommandHub } from "@otk/client";
import { type Harness, HarnessError } from "@otk/harness";
import { OtkDb, Prefs, prefsMigrations } from "@otk/store";
import { prefsOptions, register } from "../../../core/features/prefs.ts";
import { RpcRegistry } from "../../../core/ws/registry.ts";
import { registerPreferenceCommands } from "../../../web/src/commands/preferences.ts";
import { fixture } from "./support.ts";

declare module "@otk/protocol" {
  interface Preferences {
    "extension.density": "compact" | "comfortable";
  }
}
function contribute(registry: PreferenceRegistry): void {
  registry.register({
    key: "extension.density",
    default: "comfortable",
    label: "Reading density",
    validate: (value): value is Preferences["extension.density"] =>
      value === "compact" || value === "comfortable",
    display: {
      order: 100,
      control: {
        kind: "select",
        options: [
          { value: "comfortable", label: "Comfortable" },
          { value: "compact", label: "Compact" },
        ],
      },
    },
  });
}
Deno.test("feature contribution owns default, validation, display metadata and executable preference commands", async () => {
  const registry = createPreferences();
  contribute(registry);
  const root = await fixture(), db = new OtkDb(root, [prefsMigrations]);
  const options = {
    ...prefsOptions,
    defaults: registry.defaults(),
    validate: registry.validate.bind(registry),
  };
  const store = new Prefs(db, options);
  const unavailable = () =>
    Promise.reject(new Error("Preference RPC must not call the backend"));
  const harness: Harness = {
    core: {
      kind: "unused",
      version: "1",
      start: unavailable,
      stop: unavailable,
      subscriptions() {
        throw new Error("Unexpected backend access");
      },
      getSession: unavailable,
      createSession: unavailable,
      listChildren: unavailable,
      listMessages: unavailable,
    },
    capabilities: {},
  };
  const rpc = new RpcRegistry(harness, db);
  register(rpc, harness, store);
  const commands = new CommandHub(() => ({}));
  let broadcasts = 0;
  const stop = store.listen(() => broadcasts++);
  let ready = true;
  const release = registerPreferenceCommands(commands, {
    ready: () => ready,
    prefs: () => store.get(),
    set: async (key, value) => {
      await rpc.dispatch("prefs.set", { key, value });
    },
  }, registry);
  try {
    assertEquals(store.get()["extension.density"], "comfortable");
    assertEquals(registry.display().at(-1)!.label, "Reading density");
    assertEquals(
      commands.metadata("prefs.toggle.extension.density")!.title,
      "Toggle reading density",
    );
    await commands.run("prefs.toggle.extension.density");
    assertEquals(store.get()["extension.density"], "compact");
    assertEquals(broadcasts, 1);
    assertThrows(() => store.set("extension.density", "dense"), HarnessError);
    await assertRejects(
      () =>
        rpc.dispatch("prefs.set", { key: "extension.density", value: "dense" }),
      HarnessError,
    );
    assertThrows(() => store.set("extension.missing", true), HarnessError);
    assertEquals(broadcasts, 1);
    assertEquals(store.get()["extension.density"], "compact");
    ready = false;
    await assertRejects(() => commands.run("prefs.toggle.extension.density"));
    ready = true;
    await commands.run("prefs.toggle.thinking");
    assertEquals(store.get().thinking, "show");
    await commands.run("prefs.toggle.thinking");
    assertEquals(store.get().thinking, "hide");
    for (const value of ["split", "unified", "auto"]) {
      await commands.run("prefs.cycle.diffStyle");
      assertEquals(store.get().diffStyle, value);
    }
  } finally {
    stop();
    release();
    db.close();
  }
  const reopened = new OtkDb(root, [prefsMigrations]);
  try {
    assertEquals(
      new Prefs(reopened, options).get()["extension.density"],
      "compact",
    );
  } finally {
    reopened.close();
  }
  assertEquals(
    createPreferences().validate("extension.density", "compact"),
    false,
  );
});
Deno.test("preference registries reject invalid contributions and isolate selected owners", () => {
  const registry = new PreferenceRegistry();
  assertEquals(registry.list(), []);
  contribute(registry);
  assertThrows(() => contribute(registry), Error, "Duplicate preference");
  const other = new PreferenceRegistry();
  assertThrows(
    () =>
      other.register({
        key: "timestamps",
        default: false,
        label: "Timestamp",
        validate: (value): value is boolean => value === true,
      }),
    Error,
    "Invalid preference default",
  );
  assertThrows(
    () =>
      other.register({
        key: "thinking",
        default: "hide",
        label: "Thinking",
        validate: (value): value is "hide" | "show" =>
          value === "hide" || value === "show",
        display: {
          order: 1,
          control: {
            kind: "select",
            options: [{ value: "invalid", label: "Invalid" }],
          },
        },
      }),
    Error,
    "Invalid preference control",
  );
  assertEquals(other.list(), []);
});
