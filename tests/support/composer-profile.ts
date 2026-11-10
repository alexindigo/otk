// SPDX-License-Identifier: LGPL-3.0-only
import { join } from "@std/path";
import { FakeLlm } from "./fake-llm.ts";
import { browserProvider } from "./browser-native.ts";
import { McpFixture } from "./mcp.ts";
import type { nativeFixture } from "./native-fixture.ts";
import type { Profile } from "./fixture-control.ts";
import { nativeKind } from "./native.ts";

/** Native configuration/data owned by the migrated composer scenarios. */
export function composerProfile(profile: Profile) {
  const options: NonNullable<Parameters<typeof nativeFixture>[1]> = {};
  const files: Record<string, string> = {};
  let selected: FakeLlm | undefined;
  let mcp: McpFixture | undefined;
  if (
    [
      "composer-pickers",
      "composer-applied",
      "composer-selection",
      "composer-plan",
    ].includes(profile)
  ) {
    selected = browserProvider();
    selected.strict();
    const choosing = profile === "composer-selection";
    options.providers = {
      [choosing ? "selected" : "fake2"]: {
        fake: selected,
        name: choosing ? "Chosen provider" : "Second fixture provider",
        models: choosing
          ? {
            chosen: {
              name: "Chosen model",
              variants: { high: { reasoningEffort: "high" } },
            },
          }
          : {
            scripted: {
              name: "Scripted with variants",
              release_date: "2026-10-17",
              variants: {
                low: { reasoningEffort: "low" },
                high: { reasoningEffort: "high" },
              },
            },
            plain: { name: "Plain model", release_date: "2026-10-16" },
          },
      },
    };
    options.config = {
      agent: {
        reviewer: {
          mode: "primary",
          description: "Review changes",
          color: "#12abEF",
        },
      },
    };
    if (profile === "composer-applied") {
      options.config = {
        default_agent: "reviewer",
        agent: {
          reviewer: {
            mode: "primary",
            model: "fake2/scripted",
            variant: "high",
            color: "#12abEF",
          },
        },
      };
    }
    if (profile === "composer-plan") {
      options.env = {
        OPENCODE_CLIENT: "cli",
        OPENCODE_EXPERIMENTAL_PLAN_MODE: "true",
      };
      options.config = {
        agent: {
          build: { model: "fake2/scripted", variant: "high" },
          plan: { model: "fake2/scripted", variant: "low" },
        },
      };
      files[".opencode/tools/plan_enter.ts"] =
        "export default {description:'Enter plan mode fixture',args:{},async execute(){return 'Switching to plan agent'}};";
      if (nativeKind === "opencode-v2-server") {
        files[".opencode/plugins/plan-fixture.ts"] = `export default {
          id: "otk-plan-name-fixture",
          async setup(ctx) {
            return await ctx.tool.transform((editor) => {
              for (const name of ["plan_enter", "plan_exit"]) editor.add({
                name, description: "A plugin name is not an agent selection",
                input: { type: "object", properties: {}, additionalProperties: false },
                options: { codemode: false },
                async execute() { return { content: "Switching to plan agent" }; },
              });
            });
          },
        };`;
      }
    }
  }
  if (["composer-commands", "composer-mentions"].includes(profile)) {
    mcp = new McpFixture();
    options.config = {
      mcp: { fixture: { type: "remote", url: mcp.url, enabled: true } },
    };
  }
  if (
    [
      "composer-pickers",
      "composer-commands",
      "composer-long-command",
      "composer-submission",
      "composer-required",
    ].includes(profile)
  ) {
    files[".opencode/command/probe.md"] = profile === "composer-pickers"
      ? "---\ndescription: Picker selection probe\n---\nPICKER-COMMAND $ARGUMENTS"
      : profile === "composer-submission"
      ? "---\ndescription: Submission owner probe\n---\nSUBMISSION-PROBE $ARGUMENTS"
      : profile === "composer-required"
      ? "---\ndescription: Attachment probe\n---\nReview every attachment: $ARGUMENTS"
      : profile === "composer-long-command"
      ? "---\ndescription: Long fixture command\n---\nLONG-COMMAND $ARGUMENTS"
      : "---\ndescription: Fixture project command\n---\nCOMMAND-FIXTURE $ARGUMENTS";
  }
  if (profile === "composer-commands") {
    files[".opencode/skills/canary/SKILL.md"] =
      "---\nname: canary\ndescription: Fixture slash skill\n---\nSKILL-FIXTURE content";
  }
  if (profile === "composer-required") {
    Object.assign(files, {
      "selected.txt": "selected attachment bytes",
      "good.txt": "good attachment bytes",
    });
  }
  if (profile === "composer-mentions") {
    Object.assign(files, {
      "AAA.md": "alphabetical first",
      "README.md": Array.from({ length: 30 }, (_, i) => `README line ${i + 1}`)
        .join("\n"),
      "docs/guide.md": "guide",
    });
  }
  if (profile === "composer-catalog") {
    options.config = {
      agent: {
        catalog_review: { mode: "primary", description: "Catalog review" },
      },
    };
    files[".gitignore"] = ".opencode/\n";
    for (let i = 0; i < 230; i++) {
      files[`catalog/candidate-${i}.txt`] = `Candidate ${i} provider content`;
    }
  }
  const prepare = async (directory: string) => {
    for (const [name, text] of Object.entries(files)) {
      const path = join(directory, name);
      await Deno.mkdir(join(path, ".."), { recursive: true });
      await Deno.writeTextFile(path, text);
    }
  };
  options.prepare = (oc) => prepare(oc.directory);
  return { options, prepare, selected, mcp };
}
