// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals } from "@std/assert";
import { WorkPanel } from "../work-panel.ts";

const scope = "local/session";
const older = "reply:first", latest = "reply:second", newer = "reply:third";
const turns = [older, latest];

Deno.test("WorkPanel follows the latest reply with work by default", () => {
  const panel = new WorkPanel();
  assertEquals(panel.shown(scope, [], "live").turn, undefined);
  assertEquals(panel.shown(scope, [], "live").run, undefined);
  assertEquals(panel.shown(scope, turns, "live"), {
    turn: latest,
    following: true,
    run: "live",
    previous: older,
    next: undefined,
  });
  assertEquals(panel.shown(scope, [...turns, newer]).turn, newer);
});

Deno.test("WorkPanel pins older replies and resumes following on the latest", () => {
  const panel = new WorkPanel();
  panel.show(scope, { turn: older, run: "read" }, turns);
  assertEquals(panel.shown(scope, [...turns, newer], "live"), {
    turn: older,
    following: false,
    run: "read",
    previous: undefined,
    next: latest,
  });
  panel.show(scope, { turn: latest, run: "edit" }, turns);
  const selected = panel.shown(scope, turns, "live");
  assertEquals([selected.turn, selected.following, selected.run], [
    latest,
    true,
    "edit",
  ]);
  const followed = panel.shown(scope, [...turns, newer], "new live");
  assertEquals([followed.turn, followed.run], [newer, "new live"]);
  panel.show(scope, { turn: newer }, [...turns, newer]);
  assertEquals(panel.shown(scope, [...turns, newer], "live").run, "live");
});

Deno.test("WorkPanel steps in work order, clamps without losing the run, and follows at the latest", () => {
  const panel = new WorkPanel();
  panel.step(scope, -1, []);
  panel.show(scope, { turn: latest, run: "edit" }, turns);
  panel.step(scope, 1, turns);
  assertEquals(panel.shown(scope, turns).run, "edit");
  panel.step(scope, -1, turns);
  const previous = panel.shown(scope, turns);
  assertEquals([previous.turn, previous.run, previous.following], [
    older,
    undefined,
    false,
  ]);
  panel.show(scope, { turn: older, run: "read" }, turns);
  panel.step(scope, -1, turns);
  assertEquals(panel.shown(scope, turns).run, "read");
  panel.step(scope, 1, turns);
  const next = panel.shown(scope, turns, "live");
  assertEquals([next.turn, next.run, next.following], [latest, "live", true]);
});

Deno.test("WorkPanel retains an unloaded pin without showing its run on the fallback reply", () => {
  const panel = new WorkPanel();
  panel.show(scope, { turn: older, run: "read" }, turns);
  const fallback = panel.shown(scope, [latest], "live");
  assertEquals([fallback.turn, fallback.run, fallback.following], [
    latest,
    "live",
    true,
  ]);
  panel.step(scope, 1, [latest]);
  assertEquals(panel.shown(scope, turns).turn, older);
  assertEquals(panel.shown(scope, turns).run, "read");
});

Deno.test("WorkPanel scopes choices by sidecar and session; retire drops only one scope", () => {
  const panel = new WorkPanel();
  const peer = "remote/session";
  panel.show(scope, { turn: older, run: "read" }, turns);
  panel.show(peer, { turn: older, run: "fetch" }, turns);
  assertEquals(panel.shown(scope, turns).run, "read");
  assertEquals(panel.shown(peer, turns).run, "fetch");
  panel.retire(scope);
  assertEquals(panel.shown(scope, turns).turn, latest);
  assertEquals(panel.shown(peer, turns).turn, older);
  panel.clear();
  assertEquals(panel.shown(peer, turns).turn, latest);
});
