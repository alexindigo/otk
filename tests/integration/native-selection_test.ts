// SPDX-License-Identifier: LGPL-3.0-only
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { browserFixture } from "../support/browser-fixture.ts";
import { waitFor } from "../support/opencode.ts";
import { test } from "../support/resources.ts";

test("native plan transition characterization retains result provenance and agent-bearing messages", async () => {
  const f = await browserFixture({ "*": "allow" }, {
    env: { OPENCODE_CLIENT: "cli", OPENCODE_EXPERIMENTAL_PLAN_MODE: "true" },
    async prepare(oc) {
      await Deno.mkdir(join(oc.directory, ".opencode/tools"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(oc.directory, ".opencode/tools/plan_enter.ts"),
        "export default {description:'Coincidentally named external tool',args:{},async execute(){return 'Switching to plan agent'}};",
      );
    },
  });
  try {
    const providers = await f.oc.request<
      {
        providers: { id: string; models: Record<string, { cost?: unknown }> }[];
      }
    >("/config/providers");
    await Deno.writeTextFile(
      join(f.oc.root, "native-price-shapes.json"),
      JSON.stringify(
        providers.providers.map((provider) => ({
          id: provider.id,
          costs: Object.values(provider.models).map((model) => model.cost),
        })),
        null,
        2,
      ),
    );
    const session = await f.oc.session<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Native transition characterization" },
    });
    type Row = {
      info: {
        id: string;
        role: string;
        agent?: string;
        time: { completed?: number };
      };
      parts: {
        type: string;
        tool?: string;
        synthetic?: boolean;
        text?: string;
        state?: { status: string };
      }[];
    };
    const rows = () => f.oc.request<Row[]>(`/session/${session.id}/message`);
    f.fake.queue({ tool: { name: "plan_exit", input: {} } }, {
      chunks: ["Native transition settled."],
    });
    await f.oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: {
        agent: "plan",
        parts: [{ type: "text", text: "Finish planning" }],
      },
    });
    const questions = await waitFor(
      () => f.oc.request<{ id: string; sessionID: string }[]>("/question"),
      (values) => values.length > 0,
    );
    await f.oc.request(`/question/${questions[0].id}/reply`, {
      method: "POST",
      body: { answers: [["Yes"]] },
    });
    const exit = await waitFor(
      rows,
      (values) =>
        values.some((row) =>
          row.parts.some((part) =>
            part.tool === "plan_exit" && part.state?.status === "completed"
          )
        ) && values.some((row) =>
          row.info.role === "assistant" && row.info.time.completed !== undefined
        ),
    );
    await Deno.writeTextFile(
      join(f.oc.root, "native-plan-exit.json"),
      JSON.stringify(exit, null, 2),
    );
    assert(
      exit.some((row) =>
        row.info.role === "user" && row.info.agent === "build" &&
        row.parts.some((part) =>
          part.synthetic &&
          part.text?.includes("has been approved, you can now edit files")
        )
      ),
      "Native selection authority must be the synthetic agent-bearing user message",
    );
    f.fake.queue({ tool: { name: "plan_enter", input: {} } }, {
      chunks: ["External tool settled."],
    });
    await f.oc.request(`/session/${session.id}/prompt_async`, {
      method: "POST",
      body: {
        agent: "build",
        parts: [{ type: "text", text: "Run the external tool" }],
      },
    });
    const enter = await waitFor(
      rows,
      (values) =>
        values.some((row) =>
          row.parts.some((part) =>
            part.tool === "plan_enter" && part.state?.status === "completed"
          )
        ),
    );
    await Deno.writeTextFile(
      join(f.oc.root, "external-plan-enter.json"),
      JSON.stringify(enter, null, 2),
    );
    assertEquals(
      enter.filter((row) => row.info.role === "user").length,
      exit.filter((row) => row.info.role === "user").length + 1,
      "External tool adds no synthetic agent-bearing user message",
    );
    assert(
      exit.some((row) => row.parts.some((part) => part.tool === "plan_exit")),
    );
    assertEquals(questions.length, 1);
  } finally {
    await f.stop();
  }
});
