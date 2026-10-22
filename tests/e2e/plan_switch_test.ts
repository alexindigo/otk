// SPDX-License-Identifier: LGPL-3.0-only
import { test } from "../support/resources.ts";
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  browserFixture,
  openSession,
  sentFrames,
  waitForReply,
} from "../support/browser-fixture.ts";
import { FakeLlm } from "../support/fake-llm.ts";
import { waitFor } from "../support/opencode.ts";

test("V7 completed plan_exit and plan_enter switch the footer and the next prompt agent, configured model and variant at the native consumer", async () => {
  const provider = new FakeLlm();
  const f = await browserFixture({ "*": "allow" }, {
    env: { OPENCODE_CLIENT: "cli", OPENCODE_EXPERIMENTAL_PLAN_MODE: "true" },
    providers: {
      fake2: {
        fake: provider,
        models: {
          scripted: {
            name: "Plan/build fixture",
            variants: {
              low: { reasoningEffort: "low" },
              high: { reasoningEffort: "high" },
            },
          },
        },
      },
    },
    config: {
      agent: {
        build: { model: "fake2/scripted", variant: "high" },
        plan: { model: "fake2/scripted", variant: "low" },
      },
    },
    async prepare(oc) {
      // Stock 1.18.34 has no plan_enter. The approved test-local tool emits
      // the same native completed part through the real provider/session path.
      await Deno.mkdir(join(oc.directory, ".opencode/tools"), {
        recursive: true,
      });
      await Deno.writeTextFile(
        join(oc.directory, ".opencode/tools/plan_enter.ts"),
        "export default {description:'Enter plan mode fixture',args:{},async execute(){return 'Switching to plan agent'}};",
      );
    },
  });
  try {
    const session = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Plan/build switch" },
    });
    const other = await f.oc.request<{ id: string }>("/session", {
      method: "POST",
      body: { title: "Other session" },
    });
    const server = await f.sidecar(), b = await f.browser(server.url);
    const footer = async (agent: string, variant: string) => {
      await b.poll(
        `document.querySelector('.otk-composer-agent')?.textContent===${
          JSON.stringify(agent === "plan" ? "Plan" : "Build")
        } && document.querySelector('.otk-variant-picker > button > span')?.textContent===${
          JSON.stringify(variant === "low" ? "Low" : "High")
        }`,
      );
    };
    const pickAgent = async (name: string) => {
      await b.click(".otk-agent-picker > button");
      await b.poll(
        "!!document.querySelector('.otk-agent-picker .otk-popover-panel:popover-open')",
      );
      await b.click(
        `.otk-agent-picker [data-picker-key="${name}"] .otk-picker-option`,
      );
    };
    const send = async (text: string) => {
      await b.type("textarea[name=prompt]", text);
      await b.key("Enter");
    };
    const nativeUser = async (text: string, agent: string, variant: string) => {
      const messages = await waitFor(
        () =>
          f.oc.request<{
            info: { role: string; agent: string; model: unknown };
            parts: { type: string; text?: string }[];
          }[]>(`/session/${session.id}/message`),
        (messages) =>
          messages.some((m) =>
            m.info.role === "user" &&
            m.parts.some((p) => p.type === "text" && p.text === text)
          ),
      );
      const user = messages.find((m) =>
        m.info.role === "user" && m.parts.some((p) => p.text === text)
      )!;
      assertEquals(user.info.agent, agent);
      assertEquals(user.info.model, {
        providerID: "fake2",
        modelID: "scripted",
        variant,
      });
      const frame = sentFrames(b).map((f) => f.frame).find((f) =>
        f.t === "rpc" && f.method === "session.prompt" &&
        (f.params as { parts: { text?: string }[] }).parts.some((p) =>
          p.text === text
        )
      );
      assert(frame, `Missing prompt frame for ${text}`);
      const params = frame.params as Record<string, unknown>;
      assertEquals({
        agent: params.agent,
        model: params.model,
        variant: params.variant,
      }, {
        agent,
        model: { provider: "fake2", model: "scripted" },
        variant,
      });
    };
    const completed = async (name: string) => {
      const messages = await waitFor(
        () =>
          f.oc.request<
            {
              parts: {
                type: string;
                tool?: string;
                state?: { status: string };
              }[];
            }[]
          >(`/session/${session.id}/message`),
        (messages) =>
          messages.some((m) =>
            m.parts.some((p) =>
              p.type === "tool" && p.tool === name &&
              p.state?.status === "completed"
            )
          ),
      );
      assert(
        messages.some((m) =>
          m.parts.some((p) =>
            p.tool === name && p.state?.status === "completed"
          )
        ),
      );
    };
    await openSession(b, session.id);
    await pickAgent("plan");
    await footer("plan", "low");
    provider.queue({ tool: { name: "plan_exit", input: {} } }, {
      chunks: ["Plan approved."],
    });
    await send("P5 finish planning");
    await b.poll(
      "!!document.querySelector('.otk-question-dock .otk-question-options')",
    );
    // A running tool must not switch the explicit choice before approval.
    await footer("plan", "low");
    await b.click(".otk-question-options [data-question-row]:first-child");
    await b.click(".otk-question-actions .otk-primary");
    await b.poll("!!document.querySelector('.otk-question-dock dl')");
    await b.click(".otk-question-actions .otk-primary");
    await completed("plan_exit");
    await waitForReply(b, session.id, "Plan approved.");
    await footer("build", "high");
    await nativeUser("P5 finish planning", "plan", "low");

    provider.queue({ tool: { name: "plan_enter", input: {} } }, {
      chunks: ["Planning entered."],
    });
    await send("P5 reconsider the implementation");
    await completed("plan_enter");
    await waitForReply(b, session.id, "Planning entered.");
    await footer("plan", "low");
    await nativeUser("P5 reconsider the implementation", "build", "high");

    provider.queue({ chunks: ["Next plan prompt received."] });
    await send("P5 continue in plan");
    await waitForReply(b, session.id, "Next plan prompt received.");
    await nativeUser("P5 continue in plan", "plan", "low");
    assertEquals(
      f.fake.requests.length,
      0,
      "Agent-configured provider receives every prompt",
    );
    const requests = provider.requests.filter((r) => Array.isArray(r.tools));
    assert(
      requests.some((r) =>
        (r.tools as { function: { name: string } }[]).some((t) =>
          t.function.name === "plan_enter"
        )
      ),
    );
    assert(requests.some((r) => r.reasoning_effort === "low"));
    assert(requests.some((r) => r.reasoning_effort === "high"));
    // Previously completed history must not overturn a newer unsent choice.
    await pickAgent("build");
    await footer("build", "high");
    await openSession(b, other.id);
    await openSession(b, session.id);
    await footer("build", "high");
    await b.reload();
    await openSession(b, session.id);
    await footer("plan", "low");
  } finally {
    await f.stop();
  }
});
