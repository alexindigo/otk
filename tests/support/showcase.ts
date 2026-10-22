// SPDX-License-Identifier: LGPL-3.0-only
import { FakeLlm } from "./fake-llm.ts";
import { OpencodeTest } from "./opencode.ts";
import { SidecarTest } from "./sidecar.ts";
import { resources, withResources } from "./resources.ts";
if (import.meta.main) {
  await withResources("showcase", async () => {
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
    const finished = Promise.withResolvers<void>();
    const stop = () => finished.resolve();
    Deno.addSignalListener("SIGTERM", stop);
    Deno.addSignalListener("SIGINT", stop);
    resources().defer("showcase signal listeners", () => {
      Deno.removeSignalListener("SIGTERM", stop);
      Deno.removeSignalListener("SIGINT", stop);
    });
    await finished.promise;
  });
}
