// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { v1NativeTests } from "../support/native-contract.ts";
const test = v1NativeTests(
  "V1 /file,/find/file,/agent and instance-dispose characterization",
  ["tests/integration/v2-catalogs_test.ts#OC2C1"],
);
import { OpencodeTest } from "../support/opencode.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { nativeVersion } from "../support/native.ts";

test("directory catalog native file listing characterizes typed children, ignores and symlinks", async () => {
  const fake = new FakeLlm();
  const oc = await OpencodeTest.start(fake, {}, {
    async prepare(oc) {
      await Deno.mkdir(join(oc.directory, "nested"));
      await Deno.writeTextFile(
        join(oc.directory, ".gitignore"),
        "ignored.txt\n",
      );
      await Deno.writeTextFile(join(oc.directory, "ignored.txt"), "private");
      await Deno.writeTextFile(
        join(oc.directory, "nested/.gitignore"),
        "local.txt\n",
      );
      await Deno.writeTextFile(
        join(oc.directory, "nested/local.txt"),
        "nested",
      );
      await Deno.symlink(oc.directory, join(oc.directory, "nested/loop"));
      for (let i = 0; i < 220; i++) {
        await Deno.writeTextFile(
          join(oc.directory, `candidate-${i}.txt`),
          "candidate",
        );
      }
    },
  });
  try {
    const root = await oc.request<Record<string, unknown>[]>("/file?path=");
    const nested = await oc.request<Record<string, unknown>[]>(
      "/file?path=nested",
    );
    const search = await oc.request<string[]>(
      "/find/file?query=candidate&type=file&limit=200",
    );
    const agentsBefore = await oc.request<{ name: string }[]>("/agent");
    await Deno.writeTextFile(
      join(oc.directory, "opencode.json"),
      JSON.stringify({
        agent: {
          catalog_probe: {
            mode: "primary",
            description: "Directory catalog probe",
          },
        },
      }),
    );
    const agentsAfter = await oc.request<{ name: string }[]>("/agent");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const agentsDelayed = await oc.request<{ name: string }[]>("/agent");
    // The test controls its idle fixture process. OTK never forces native disposal.
    await oc.restart();
    const agentsReloaded = await oc.request<{ name: string }[]>("/agent");
    await Deno.writeTextFile(
      join(oc.root, "catalog-characterization.json"),
      JSON.stringify(
        {
          nativeVersion,
          root,
          nested,
          searchCount: search.length,
          agentsBefore,
          agentsAfter,
          agentsDelayed,
          agentsReloaded,
        },
        null,
        2,
      ),
    );
    assert(
      root.filter((row) => String(row.name).startsWith("candidate-")).length ===
        220,
    );
    assertEquals(root.find((row) => row.name === "ignored.txt")?.ignored, true);
    assertEquals(root.find((row) => row.name === "nested")?.type, "directory");
    assert(search.length <= 200);
    console.log(
      JSON.stringify({
        nativeVersion,
        rootCount: root.length,
        nested,
        searchCount: search.length,
        newAgentVisibleWithoutDisposal: agentsAfter.some((agent) =>
          agent.name === "catalog_probe"
        ),
        newAgentVisibleAfterDelay: agentsDelayed.some((agent) =>
          agent.name === "catalog_probe"
        ),
        newAgentVisibleAfterReload: agentsReloaded.some((agent) =>
          agent.name === "catalog_probe"
        ),
        agentsBefore: agentsBefore.map((agent) => agent.name),
        agentsAfter: agentsAfter.map((agent) => agent.name),
      }),
    );
    assert(
      agentsReloaded.some((agent) => agent.name === "catalog_probe"),
      "The control proves the file and agent definition are valid",
    );
  } finally {
    await oc.stop();
    await fake.stop();
  }
});
