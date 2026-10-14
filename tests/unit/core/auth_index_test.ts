// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { authenticator } from "otplib";
import { encodeBase32 } from "@std/encoding/base32";
import {
  allowedOrigin,
  AuthState,
  hashPassword,
  IndexStore,
  LocalAuth,
  verifyPassword,
} from "../../../core/mod.ts";
import type { IndexEntry, ServerFrame } from "@otk/protocol";
import { cfg, fixture } from "./support.ts";

Deno.test("PBKDF2 round-trip, incorrect password and malformed digest", async () => {
  const hash = await hashPassword("test-password");
  assert(await verifyPassword("test-password", hash));
  assert(!await verifyPassword("wrong", hash));
  assert(!await verifyPassword("test-password", "pbkdf2_sha256$0$00$00"));
});
Deno.test("JWT expiry and identity validation", async () => {
  const settings = {
    ...cfg().auth,
    type: "password",
    username: "Tester",
    password: "password",
    secretkey: "01234567890123456789012345678901",
  };
  let now = Date.now();
  const auth = new LocalAuth(settings, () => now),
    token = await auth.login("tester", "password");
  await auth.validateToken(token);
  now += 31 * 86_400_000;
  await assertRejects(() => auth.validateToken(token));
  await assertRejects(() => auth.login("another", "password"));
});
Deno.test("TOTP accepts adjacent time window and rejects replay", async () => {
  const now = 1_791_360_000_000,
    settings = {
      ...cfg().auth,
      type: "totp",
      username: "tester",
      password: "password",
      secretkey: "01234567890123456789012345678901",
      totpkey: "OTK test seed",
    };
  const otp = authenticator.clone();
  otp.options = { epoch: now - 30_000 };
  const code = otp.generate(
    encodeBase32(new TextEncoder().encode(settings.totpkey)).replace(/=+$/, ""),
  );
  const auth = new LocalAuth(settings, () => now);
  await auth.login("tester", "password" + code);
  await assertRejects(() => auth.login("tester", "password" + code));
});
Deno.test("Origin rejects missing, foreign and null even in none mode", () => {
  const settings = cfg();
  settings.auth.type = "none";
  settings.server.origins = ["https://remote"];
  for (const origin of [undefined, "null", "https://foreign"]) {
    assert(
      !allowedOrigin(
        new Request("http://127.0.0.1:1502/api/ws", {
          headers: origin ? { Origin: origin } : {},
        }),
        settings,
      ),
    );
  }
  for (const origin of ["http://127.0.0.1:1502", "https://remote"]) {
    assert(
      allowedOrigin(
        new Request("http://127.0.0.1:1502/api/ws", {
          headers: { Origin: origin },
        }),
        settings,
      ),
    );
  }
});
Deno.test("setup stores hashed password and private state, refuses repeat", async () => {
  const settings = cfg();
  settings.state.path = join(await fixture(), "private");
  const auth = new AuthState(settings);
  await auth.setup({
    type: "password",
    username: "Tester",
    password: "secret",
  });
  const stored = await Deno.readTextFile(
    join(settings.state.path, "auth.toml"),
  );
  assert(!stored.includes('password = "secret"'));
  assert(stored.includes("pbkdf2_sha256"));
  assertEquals((await Deno.stat(settings.state.path)).mode! & 0o777, 0o700);
  assertEquals(
    (await Deno.stat(join(settings.state.path, "auth.toml"))).mode! & 0o777,
    0o600,
  );
  await assertRejects(() => auth.setup({ type: "none" }));
});
Deno.test("index coalesces mutations, revisions and reset invalidates pending patches", async () => {
  const store = new IndexStore(), frames: ServerFrame[] = [];
  const entry: IndexEntry = {
    id: "ses_root",
    projectID: "project",
    directory: "/project",
    title: "Root",
    timeCreated: 1,
    timeUpdated: 2,
    archived: false,
    status: "idle",
    attention: {
      permissions: 0,
      questions: 0,
      childPermissions: 0,
      childQuestions: 0,
    },
  };
  store.listen((frame) => frames.push(frame));
  store.upsert(entry);
  store.upsert({ ...entry, title: "Updated" });
  await Promise.resolve();
  assertEquals(frames.length, 1);
  assertEquals(frames[0].t, "index.patch");
  assertEquals(store.rev, 2);
  store.remove(entry.id);
  store.reset([entry]);
  await Promise.resolve();
  assertEquals(frames.length, 2);
  assertEquals(frames[1].t, "index.snapshot");
});
