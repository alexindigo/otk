// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { createNavigation, type NavigationEnvironment } from "../navigation.ts";

function fixture(storage: NavigationEnvironment["storage"] = memory()) {
  const location = { hash: "#a", pathname: "/app", search: "?a=1" };
  const stack: { hash: string; state: unknown }[] = [{ hash: "#a", state: {} }];
  const calls: number[] = [];
  let at = 0, changed: (() => void) | undefined, accept = true;
  const hash = (url: unknown) => new URL(String(url), "http://localhost").hash;
  const environment: NavigationEnvironment = {
    location,
    storage,
    history: {
      get state() {
        return stack[at].state;
      },
      replaceState(state, _, url) {
        stack[at] = { state, hash: url ? hash(url) : location.hash };
        location.hash = stack[at].hash;
      },
      pushState(state, _, url) {
        stack.splice(++at, Infinity, { state, hash: hash(url) });
        location.hash = stack[at].hash;
      },
      go: (delta) => calls.push(delta!),
    },
    listen(onChange) {
      changed = onChange;
      return () => changed = undefined;
    },
  };
  const start = () => {
    const nav = createNavigation({
      accept: () => accept,
      apply() {},
      intent() {},
    }, environment);
    nav.start();
    return nav;
  };
  return {
    start,
    stack,
    calls,
    accept(value: boolean) {
      accept = value;
    },
    move(delta: number) {
      at += delta;
      location.hash = stack[at].hash;
      changed?.();
    },
    type(hash: string) {
      stack.splice(++at, Infinity, { state: null, hash });
      location.hash = hash;
      changed?.();
    },
  };
}

function memory() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

Deno.test("history records accepted pushes and replacements, not same-session reselection", () => {
  const f = fixture(), nav = f.start();
  nav.open("#b");
  nav.open("#b");
  nav.open("#c", "replace", { page: true });
  assertEquals(f.stack.map((s) => s.hash), ["#a", "#c"]);
  assertEquals(nav.history().at, 1);
  assertEquals(nav.history().back, { hash: "#a" });
  assertEquals(nav.go(1), false);
  assertEquals(nav.go(-1), true);
  assertEquals(f.calls, [-1]);
  assertEquals(nav.history().at, 1);
  f.move(-1);
  assertEquals(nav.history().at, 0);
  assertEquals(nav.history().back, undefined);
  assertEquals(nav.history().forward, { hash: "#c", page: true });
});

Deno.test("declined traversal restores the accepted entry without changing recorded targets", () => {
  const f = fixture(), nav = f.start();
  nav.open("#b");
  nav.open("#c");
  const before = nav.history();
  f.accept(false);
  f.move(-1);
  assertEquals(f.calls, [1]);
  f.move(1);
  assertEquals(nav.history(), before);
});

Deno.test("an action settles only after accepted traversal or completed guard restoration", async () => {
  const f = fixture(), nav = f.start();
  nav.open("#b");
  let acknowledged: boolean | undefined;
  const pending = nav.traverse(-1).then((accepted) => acknowledged = accepted);
  await Promise.resolve();
  assertEquals(acknowledged, undefined);
  f.accept(false);
  f.move(-1);
  assertEquals(f.calls, [-1, 1]);
  await Promise.resolve();
  assertEquals(acknowledged, undefined);
  f.move(1);
  assertEquals(await pending, false);
  assertEquals(nav.history().at, 1);
  f.accept(true);
  const accepted = nav.traverse(-1);
  f.move(-1);
  assertEquals(await accepted, true);
  assertEquals(nav.history().at, 0);
});

Deno.test("reload keeps both labelled neighbors and never labels an off-screen entry", () => {
  const f = fixture(), nav = f.start();
  let notifications = 0;
  nav.subscribe(() => notifications++);
  nav.describe("#b", { title: "Off screen", project: "Other" });
  nav.describe("#a", { title: "First", project: "One" });
  nav.describe("#a", { title: "First", project: "One" });
  assertEquals(notifications, 1);
  nav.open("#b");
  nav.open("#c");
  nav.describe("#c", { title: "Third", project: "Two" });
  f.move(-1);
  nav.stop();
  assertEquals(f.start().history(), {
    at: 1,
    back: { hash: "#a", title: "First", project: "One" },
    forward: { hash: "#c", title: "Third", project: "Two" },
  });
  assertEquals(fixture().start().history().back, undefined);
});

for (
  const storage of [null, {
    getItem() {
      throw new Error("storage blocked");
    },
    setItem() {
      throw new Error("storage full");
    },
  }]
) {
  Deno.test(`history degrades on reload with ${storage ? "blocked" : "no"} storage`, () => {
    const f = fixture(storage), nav = f.start();
    nav.open("#b");
    nav.open("#c");
    f.move(-1);
    assertEquals(nav.history().forward, { hash: "#c" });
    nav.stop();
    const restored = f.start();
    assertEquals(restored.history().back, "unrecorded");
    assertEquals(restored.history().forward, undefined);
    assertEquals(restored.go(-1), true);
  });
}

Deno.test("a typed hash truncates obsolete forward entries", () => {
  const f = fixture(), nav = f.start();
  nav.open("#b");
  nav.open("#c");
  nav.open("#d");
  f.move(-3);
  f.type("#typed");
  assertEquals(nav.history().at, 1);
  assertEquals(nav.history().back, { hash: "#a" });
  assertEquals(nav.history().forward, undefined);
  f.move(-1);
  assertEquals(nav.history().forward, { hash: "#typed" });
});

Deno.test("history bounds the record and does not offer a pruned neighbor", () => {
  const storage = memory(), f = fixture(storage), nav = f.start();
  for (let i = 1; i <= 55; i++) nav.open(`#${i}`);
  const state = f.stack.at(-1)!.state as { otkNavigation: { owner: string } };
  const key = `otk.navigation.v1:${state.otkNavigation.owner}`;
  assertEquals(JSON.parse(storage.getItem(key)!).entries.length, 50);
  f.move(-49);
  assertEquals(nav.history().at, 6);
  assertEquals(nav.history().back, undefined);
  assertEquals(nav.go(-1), false);
});
