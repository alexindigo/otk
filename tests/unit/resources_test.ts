// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  acquire,
  resources,
  test,
  withResources,
} from "../support/resources.ts";
import { ownedProcess } from "../support/process.ts";

test("resource scope does not turn an undefined rejection into a passing test", async () => {
  let rejected = false;
  try {
    await withResources("undefined failure", () => Promise.reject(undefined));
  } catch (error) {
    rejected = true;
    assertEquals(error, undefined);
  }
  assert(rejected, "The test runner swallowed a thrown undefined value");
});

test("resource scope owns TMPDIR scratch and reverses every disposer after a body failure", async () => {
  const order: number[] = [];
  let root = "";
  const original = new Error("original body failure");
  const error = await assertRejects(
    () =>
      withResources("forced body failure", async () => {
        root = await resources().tempDir();
        assert(root.startsWith(Deno.env.get("TMPDIR")! + "/"));
        await Deno.writeTextFile(join(root, "scratch"), "scratch");
        resources().defer("first", () => {
          order.push(1);
        });
        resources().defer("throwing disposer", () => {
          order.push(2);
          throw new Error("cleanup failure");
        });
        resources().defer("last", () => {
          order.push(3);
        });
        throw original;
      }),
    AggregateError,
  );
  assertEquals(error.errors[0], original);
  assertEquals(order, [3, 2, 1]);
  await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
});

test("transactional acquisition cleans immediately and evidence failure cannot skip disposal", async () => {
  let root = "", disposed = 0;
  const error = await assertRejects(
    () =>
      acquire("forced construction failure", async () => {
        root = await resources().tempDir();
        resources().defer("service", () => {
          disposed++;
        });
        resources().evidence("broken capture", () => {
          throw new Error("capture failure");
        });
        throw new Error("construction failure");
      }),
    AggregateError,
  );
  assertEquals(error.errors.length, 2);
  assertEquals(disposed, 1);
  await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
});

test("scope release is joined and idempotent across explicit cleanup and scope completion", async () => {
  let disposed = 0;
  await withResources("joined release", async () => {
    const stop = resources().defer("joined", () => {
      disposed++;
    });
    assertEquals(stop(), stop());
    await stop();
  });
  assertEquals(disposed, 1);
});

test("process owner terminates descendants even after its leader has exited", async () => {
  let childPID = 0;
  await withResources("exited leader", async () => {
    const root = await resources().tempDir();
    const pidFile = join(root, "descendant");
    const { child } = ownedProcess("/usr/bin/bash", [
      "-c",
      'sleep 300 & printf "%s" "$!" > "$1"',
      "owned",
      pidFile,
    ], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    childPID = Number(await Deno.readTextFile(pidFile));
    assert(childPID > 0);
    Deno.kill(childPID, "SIGCONT");
  });
  const output = await new Deno.Command("/usr/bin/ps", {
    args: ["-o", "stat=", "-p", String(childPID)],
  }).output();
  const state = new TextDecoder().decode(output.stdout).trim();
  assert(
    !output.success || state.startsWith("Z"),
    `Descendant survived: ${childPID} ${state}`,
  );
});
