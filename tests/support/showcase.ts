// SPDX-License-Identifier: LGPL-3.0-only
import { FakeLlm } from "./fake-llm.ts";
import { OpencodeTest } from "./opencode.ts";
import { SidecarTest } from "./sidecar.ts";
if (import.meta.main) {
  const fake = new FakeLlm();
  const oc = await OpencodeTest.start(fake);
  await oc.request("/session", {
    method: "POST",
    body: { title: "OTK sidecar core · VM verification" },
  });
  await oc.request("/session", {
    method: "POST",
    body: { title: "M1 session index · scripted provider" },
  });
  const sidecar = await SidecarTest.start(oc, { server: { port: 1502 } });
  console.info(`OTK showcase ready: ${sidecar.url}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await sidecar.stop();
    await oc.stop();
    await fake.stop();
    Deno.exit();
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
}
