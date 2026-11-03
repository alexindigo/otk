// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { hash } from "../../scripts/tests/source.ts";

Deno.test("one prepared tree serves multiple native versions without rebinding identities", async () => {
  const root = await Deno.makeTempDir();
  try {
    const directory = join(root, ".test-state/builds/tree");
    await Deno.mkdir(join(directory, "natives"), { recursive: true });
    const binary = join(directory, "otk");
    const consumer = join(directory, "digest-consumer");
    const web = join(directory, "web.js");
    await Deno.writeTextFile(binary, "shipped");
    await Deno.writeTextFile(consumer, "independent");
    await Deno.writeTextFile(web, "web");
    const treeReceipt = {
      schema: 1,
      tree: "tree",
      binary,
      binarySha256: await hash(binary),
      digestConsumer: { path: consumer, sha256: await hash(consumer) },
      web: { [web]: await hash(web) },
      deno: Deno.version.deno,
      preparedAt: new Date().toISOString(),
      seconds: 0,
    };
    const text = JSON.stringify(treeReceipt);
    await Deno.writeTextFile(join(directory, "receipt.json"), text);
    // Subprocesses exercise the receipt owner with separate version selections.
    // The source tree and its build receipt stay identical.
    const owner =
      new URL("../../scripts/tests/prepare.ts", import.meta.url).href;
    for (const version of ["1.18.34", "1.18.35"]) {
      const cache = join(root, `cache-${version}`);
      await Deno.mkdir(
        join(cache, "dependencies/node_modules/@opencode-ai/plugin"),
        {
          recursive: true,
        },
      );
      await Deno.writeTextFile(
        join(cache, "ready.json"),
        JSON.stringify({ opencode: version }),
      );
      await Deno.writeTextFile(
        join(
          cache,
          "dependencies/node_modules/@opencode-ai/plugin/package.json",
        ),
        JSON.stringify({ version }),
      );
      await Deno.writeTextFile(
        join(cache, "dependencies/package-lock.json"),
        JSON.stringify({
          packages: {
            "": { dependencies: { "@opencode-ai/plugin": version } },
          },
        }),
      );
      const native = join(root, `native-${version}`);
      await Deno.writeTextFile(native, `#!/bin/sh\nprintf "${version}\\n"\n`);
      await Deno.chmod(native, 0o755);
    }
    const invoke = async (version: string, prepare: boolean) => {
      const script = `import * as owner from ${JSON.stringify(owner)};
        ${prepare ? 'await owner.prepareNative("tree");' : ""}
        console.log(JSON.stringify(await owner.readBuild("tree")));`;
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          "--config",
          new URL("../../deno.json", import.meta.url).pathname,
          script,
        ],
        cwd: root,
        env: {
          OTK_TEST_VERSION: version,
          OTK_TEST_OPENCODE: join(root, `native-${version}`),
          OTK_TEST_PROVIDER_CACHE: join(root, `cache-${version}`),
        },
      }).output();
      if (!result.success) {
        throw new Error(new TextDecoder().decode(result.stderr));
      }
      return JSON.parse(new TextDecoder().decode(result.stdout));
    };
    const first = await invoke("1.18.34", true);
    await assertRejects(() => invoke("1.18.35", false), Error, "NotFound");
    const second = await invoke("1.18.35", true);
    assertEquals(first.binarySha256, second.binarySha256);
    assertEquals(first.native.version, "1.18.34");
    assertEquals(second.native.version, "1.18.35");
    assertEquals((await invoke("1.18.34", false)).native, first.native);
    assertEquals(
      await Deno.readTextFile(join(directory, "receipt.json")),
      text,
    );
    // Preserve --version output but change executable bytes for the same version.
    const changed = join(root, "native-1.18.34");
    const original = await Deno.readTextFile(changed);
    await Deno.writeTextFile(
      changed,
      '#!/bin/sh\n# changed bytes\nprintf "1.18.34\\n"\n',
    );
    await assertRejects(
      () => invoke("1.18.34", true),
      Error,
      "Prepared native identity mismatch",
    );
    await assertRejects(
      () => invoke("1.18.34", false),
      Error,
      "Prepared native identity mismatch",
    );
    await Deno.writeTextFile(changed, original);
    assertEquals((await invoke("1.18.34", false)).native, first.native);
    const ready = join(root, "cache-1.18.34/ready.json");
    await Deno.writeTextFile(
      ready,
      JSON.stringify({ opencode: "1.18.34", changed: true }),
    );
    await assertRejects(
      () => invoke("1.18.34", true),
      Error,
      "Prepared provider cache identity mismatch",
    );
    await assertRejects(
      () => invoke("1.18.34", false),
      Error,
      "Prepared provider cache identity mismatch",
    );
    assertEquals((await invoke("1.18.35", false)).native, second.native);
    await Deno.writeTextFile(web, "corrupted web asset");
    await assertRejects(
      () => invoke("1.18.35", true),
      Error,
      "Prepared web asset changed",
    );
    await assertRejects(
      () => invoke("1.18.35", false),
      Error,
      "Prepared web asset changed",
    );
    assertEquals(
      await Deno.readTextFile(join(directory, "receipt.json")),
      text,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
