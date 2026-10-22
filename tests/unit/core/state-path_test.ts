// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { Harness } from "@otk/harness";
import { OtkDb, Prefs, prefsMigrations } from "@otk/store";
import { startApplication } from "../../../application.ts";
import { serveBackend } from "../../../core/example.ts";
import { AuthState, config, prefsOptions } from "../../../core/mod.ts";
import { defaultsPath, fixture } from "../../support/config.ts";

for (
  const scenario of [
    "xdg",
    "home",
    "overlay port",
    "env port",
    "overlay path",
    "env path",
    "empty env path",
  ]
) {
  Deno.test(`configuration publishes one state path for ${scenario}`, async () => {
    const root = await fixture();
    try {
      const env: Record<string, string> = {
        HOME: join(root, "home"),
        XDG_STATE_HOME: join(root, "xdg"),
      };
      let overlay = "";
      let expected = join(env.XDG_STATE_HOME, "otk", "1502");
      if (scenario === "home") {
        delete env.XDG_STATE_HOME;
        expected = join(env.HOME, ".local/state/otk/1502");
      } else if (scenario === "overlay port") {
        overlay = "[server]\nport = 31502\n";
        expected = join(env.XDG_STATE_HOME, "otk", "31502");
      } else if (scenario === "env port") {
        overlay = "[server]\nport = 31502\n";
        env.OTK_SERVER_PORT = "31503";
        expected = join(env.XDG_STATE_HOME, "otk", "31503");
      } else if (scenario === "overlay path") {
        expected = join(root, "overlay-state");
        overlay = `[state]\npath = ${JSON.stringify(expected)}\n`;
      } else if (scenario === "env path") {
        overlay = `[state]\npath = ${JSON.stringify(join(root, "unused"))}\n`;
        env.OTK_STATE_PATH = expected = join(root, "env-state");
      } else if (scenario === "empty env path") {
        overlay = `[state]\npath = ${JSON.stringify(join(root, "unused"))}\n`;
        env.OTK_STATE_PATH = "";
      }
      const overlayPath = join(root, "overlay.toml");
      await Deno.writeTextFile(overlayPath, overlay);
      const sources = { defaultsPath, overlayPath, env };
      const settings = config(sources);
      assertEquals(
        settings.state.path,
        expected,
        "Unresolved state path escaped configuration",
      );
      const db = new OtkDb(settings.state.path, [prefsMigrations]);
      try {
        new Prefs(db, prefsOptions).set("timestamps", true);
        const auth = new AuthState(settings);
        await auth.setup({ type: "none" });
        assertEquals(auth.setupRequired, false);
      } finally {
        db.close();
      }
      assert((await Deno.stat(join(expected, "otk.db"))).isFile);
      assert((await Deno.stat(join(expected, "auth.toml"))).isFile);
      assertEquals((await Deno.stat(expected)).mode! & 0o777, 0o700);
      const restored = config(sources);
      assertEquals(restored.state.path, expected);
      assertEquals(new AuthState(restored).setupRequired, false);
      const reopened = new OtkDb(restored.state.path, [prefsMigrations]);
      try {
        assertEquals(new Prefs(reopened, prefsOptions).get().timestamps, true);
      } finally {
        reopened.close();
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

for (
  const [name, start] of [["application", startApplication], ["minimal core", (
    settings: Parameters<typeof startApplication>[0],
    backend: Harness,
    root: string,
  ) => serveBackend(backend, settings, root)]] as const
) {
  Deno.test(`${name} starts with default state path and restores setup from the database directory`, async () => {
    const root = await fixture();
    const cwd = Deno.cwd();
    const processStateHome = Deno.env.get("XDG_STATE_HOME");
    const env = { XDG_STATE_HOME: join(root, "xdg"), OTK_SERVER_PORT: "0" };
    const expected = join(env.XDG_STATE_HOME, "otk", "0");
    const backend: Harness = {
      core: {
        kind: "external",
        version: "1",
        start: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        subscriptions() {},
        getSession: () => Promise.reject(new Error("No sessions")),
        createSession: () => Promise.reject(new Error("No sessions")),
        listChildren: () => Promise.resolve([]),
        listMessages: () => Promise.resolve([]),
      },
      capabilities: {},
    };
    try {
      Deno.chdir(root);
      Deno.env.set("XDG_STATE_HOME", join(root, "process-xdg"));
      for (const first of [true, false]) {
        const settings = config({ defaultsPath, env });
        const app = await start(settings, backend, root);
        try {
          const base = `http://127.0.0.1:${app.server.addr.port}`;
          const discovery = await fetch(base + "/api/session");
          const info = await discovery.json();
          assertEquals(info.setupRequired, first);
          if (first) {
            const response = await fetch(base + "/api/setup", {
              method: "POST",
              headers: { Origin: base, "Content-Type": "application/json" },
              body: JSON.stringify({ type: "none" }),
            });
            assertEquals(response.status, 200, await response.text());
          }
          assert((await Deno.stat(join(expected, "otk.db"))).isFile);
          assert((await Deno.stat(join(expected, "auth.toml"))).isFile);
        } finally {
          await app.stop();
        }
      }
    } finally {
      Deno.chdir(cwd);
      if (processStateHome === undefined) Deno.env.delete("XDG_STATE_HOME");
      else Deno.env.set("XDG_STATE_HOME", processStateHome);
      await Deno.remove(root, { recursive: true });
    }
  });
}
