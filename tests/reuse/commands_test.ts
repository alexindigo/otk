// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import { CommandHub } from "@otk/client";
/** A different application uses the public hub without DOM, Solid or OTK core. */
Deno.test("plain Deno command consumer changes its selected resource and tears down feature ownership", async () => {
  let selected = "alpha";
  const values = new Map([["alpha", 1], ["beta", 10]]);
  const commands = new CommandHub(() => ({ session: selected }));
  const registerCounter = () =>
    commands.register({
      id: "counter.add",
      title: "Add to counter",
      category: "Counter",
      slash: ["add"],
      run: (ctx, delta: number = 1) => {
        const next = values.get(ctx.session!)! + delta;
        values.set(ctx.session!, next);
        return next;
      },
    });
  const release = registerCounter();
  assertEquals(await commands.run<number>(commands.resolveSlash("add")!, 3), 4);
  selected = "beta";
  assertEquals(await commands.run<number>("counter.add", 2), 12);
  assertEquals([...values], [["alpha", 4], ["beta", 12]]);
  release();
  await assertRejects(
    () => commands.run("counter.add"),
    Error,
    "Unknown command",
  );
  const again = registerCounter();
  assertEquals(await commands.run<number>("counter.add"), 13);
  again();
  assertEquals(commands.list(), []);
});
