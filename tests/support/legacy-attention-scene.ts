// SPDX-License-Identifier: LGPL-3.0-only
import { attentionScenario } from "./attention-scenario.ts";
import { Cdp } from "./cdp.ts";
import type {
  Commands,
  ControlRequest,
  Profile,
  TestLease,
} from "./fixture-control.ts";

/** Fixed V states retain the legacy renderer until the T3 theme sweep. */
export async function legacyAttentionScene(profile: Profile) {
  const owner = await attentionScenario(profile);
  const lease = await owner.dispatch({
    v: 1,
    id: "begin",
    command: "beginTest",
    params: { identity: "fixed-visual-state" },
  }) as TestLease;
  const b = await Cdp.launch(owner.info.root);
  const call = <M extends keyof Commands>(command: M, params: Commands[M]) =>
    owner.dispatch(
      { v: 1, id: crypto.randomUUID(), command, params } as ControlRequest,
    );
  return {
    b,
    lease,
    url: owner.info.url,
    rpc: (method: string, params: import("./fixture-control.ts").Json) =>
      call("productRpc", { lease: lease.lease, method, params }),
    call,
    async close() {
      await b.close();
      await call("endTest", { lease: lease.lease });
      await call("stop", {});
    },
  };
}
