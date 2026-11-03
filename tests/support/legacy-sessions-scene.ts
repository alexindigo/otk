// SPDX-License-Identifier: LGPL-3.0-only
import { Cdp } from "./cdp.ts";
import { sessionsScenario } from "./sessions-scenario.ts";
import type { Json, Profile, TestLease } from "./fixture-control.ts";

/** Temporary T2 fixed V owner. All navigation/native outcomes live in Playwright. */
export async function legacySessionsScene(
  profile: Profile,
  theme: string,
  run: (
    scene: {
      b: Cdp;
      root: string;
      rpc(method: string, params: Json): Promise<unknown>;
    },
  ) => Promise<void>,
  id = "tstv1-otk",
) {
  const owner = await sessionsScenario(profile);
  const lease = await owner.dispatch({
    v: 1,
    id: "begin",
    command: "beginTest",
    params: { identity: "legacy-paint" },
  }) as TestLease;
  const rpc = (method: string, params: Json) =>
    owner.dispatch({
      v: 1,
      id: crypto.randomUUID(),
      command: "productRpc",
      params: { lease: lease.lease, method, params },
    });
  const b = await Cdp.launch(owner.info.root);
  try {
    await rpc("prefs.set", { key: "theme", value: theme });
    await rpc("prefs.set", { key: "animationsOff", value: true });
    await rpc("layout.patch", { rightCollapsed: false, rightView: "sessions" });
    await b.goto(owner.info.url + "/#/local/" + id);
    await b.poll("!!document.querySelector('.otk-project-sessions')");
    await b.evaluate(
      "document.fonts.ready.then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))",
    );
    await run({ b, root: owner.info.root, rpc });
  } finally {
    await b.close();
    await owner.dispatch({
      v: 1,
      id: "end",
      command: "endTest",
      params: { lease: lease.lease },
    });
    await owner.dispatch({ v: 1, id: "stop", command: "stop", params: {} });
  }
}
