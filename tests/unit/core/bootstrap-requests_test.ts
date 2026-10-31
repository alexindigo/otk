// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import type { Harness } from "@otk/harness";
import { OtkDb, Requests, requestsMigrations } from "@otk/store";
import { AuthState } from "../../../core/auth/state.ts";
import { BootstrapRequests } from "../../../core/http/bootstrap.ts";
import { test } from "../../support/resources.ts";
import { cfg, fixture } from "./support.ts";

test("bootstrap features acknowledge setup/login/discovery and replay cookies only through their origin-bound result receipt", async () => {
  const settings = cfg();
  settings.auth.type = "";
  settings.state.path = await fixture();
  settings.server.origins = ["http://other"];
  const auth = new AuthState(settings),
    db = new OtkDb(settings.state.path, [requestsMigrations], { busyms: 5000 });
  const windows = new Requests(db);
  const backend = { core: { kind: "external", version: "1" } } as Harness;
  const bootstrap = new BootstrapRequests({
    cfg: settings,
    auth,
    backend,
    store: db,
    window: () => {
      const w = windows.window(Date.now(), settings.requests.windowms);
      return { id: w.id, expiresAt: w.expires_at };
    },
  });
  await bootstrap.start();
  const ref = () => ({
    clientID: crypto.randomUUID(),
    key: crypto.randomUUID(),
    id: crypto.randomUUID(),
    window: "bootstrap",
  });
  const secret = "a".repeat(64);
  const request = (path: string, cookie?: string) =>
    new Request(`http://fixture/api/${path}`, {
      method: "POST",
      headers: { origin: "http://fixture", ...(cookie ? { cookie } : {}) },
    });
  const held = Promise.withResolvers<void>();
  const originalSetup = auth.setup.bind(auth);
  let setups = 0;
  auth.setup = async (input) => {
    setups++;
    await held.promise;
    return originalSetup(input);
  };
  try {
    const setup = ref(),
      input = {
        type: "password",
        username: "alice",
        password: "private fixture password",
      };
    const accepted = await bootstrap.admit(
      "bootstrap.setup",
      request("setup"),
      setup,
      input,
      secret,
    );
    assertEquals(accepted.status, 202);
    assertEquals(accepted.headers.get("set-cookie"), null);
    await bootstrap.admit(
      "bootstrap.setup",
      request("setup"),
      setup,
      input,
      secret,
    );
    const result = bootstrap.events(
      request("request-events"),
      setup,
      0,
      secret,
    );
    held.resolve();
    const setupResponse = await result;
    assert((await setupResponse.text()).includes('"ok":true'));
    const setupCookie = setupResponse.headers.get("set-cookie");
    assert(setupCookie);
    assert(setupCookie.includes("HttpOnly"));
    assert(
      await auth.authenticated(request("session", setupCookie.split(";")[0])),
      "Setup's completion must authenticate the browser that supplied credentials",
    );
    const setupReplay = await bootstrap.events(
      request("request-events"),
      { ...setup, id: crypto.randomUUID() },
      0,
      secret,
    );
    assertEquals(setupReplay.headers.get("set-cookie"), setupCookie);
    await setupReplay.text();
    assertEquals(setups, 1);
    assertEquals(auth.setupRequired, false);
    const login = ref();
    assertEquals(
      (await bootstrap.admit("bootstrap.login", request("login"), login, {
        username: "alice",
        password: input.password,
      }, secret)).status,
      202,
    );
    const response = await bootstrap.events(
      request("request-events"),
      login,
      0,
      secret,
    );
    const cookie = response.headers.get("set-cookie")!;
    assert(cookie.includes("HttpOnly"));
    assert((await response.text()).includes('"ok":true'));
    const replay = await bootstrap.events(
      request("request-events"),
      { ...login, id: crypto.randomUUID() },
      0,
      secret,
    );
    assertEquals(replay.headers.get("set-cookie"), cookie);
    await replay.text();
    const wrongOrigin = await bootstrap.events(
      new Request("http://fixture/api/request-events", {
        method: "POST",
        headers: { origin: "http://other" },
      }),
      login,
      0,
      secret,
    );
    assertEquals(wrongOrigin.status, 403);
    await wrongOrigin.text();
    const session = ref();
    await bootstrap.admit(
      "bootstrap.session",
      request("session", cookie.split(";")[0]),
      session,
      null,
      secret,
    );
    const discovery = await bootstrap.events(
      request("request-events"),
      session,
      0,
      secret,
    );
    const body = await discovery.text();
    assert(body.includes('"authenticated":true'));
    assert(body.includes('"policy":'));
    assert(body.includes('"principal":'));
    const logout = ref();
    await bootstrap.admit(
      "bootstrap.logout",
      request("logout", cookie.split(";")[0]),
      logout,
      {},
      secret,
    );
    const signedOut = await bootstrap.events(
      request("request-events"),
      logout,
      0,
      secret,
    );
    assert(signedOut.headers.get("set-cookie")?.includes("Max-Age=0"));
    await signedOut.text();
    assertEquals(
      db.connection.prepare("SELECT COUNT(*) AS count FROM request_receipts")
        .get()?.count,
      0,
      "Bootstrap credentials and cookie equality hashes must never reach SQLite",
    );
  } finally {
    held.resolve();
    await bootstrap.stop();
    db.close();
  }
});
