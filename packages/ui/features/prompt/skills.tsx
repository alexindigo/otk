// SPDX-License-Identifier: LGPL-3.0-only
import "./skills.css" with { type: "text" };
import { createSignal, Show } from "solid-js";
import { skillChoices } from "@otk/client";
import type { SkillOption } from "@otk/protocol";
import ListPicker, {
  type ListPickerControl,
} from "../../components/ListPicker.tsx";
import { ownedCommand } from "../../keyboard/context.tsx";
import type { PromptContext, PromptRegistry } from "../../registries/prompt.ts";
import { submitPromptCommand } from "./slash.ts";

export function registerSkillsPrompt(prompt: PromptRegistry): void {
  prompt.register({
    id: "skills",
    create(ctx) {
      const picker = createSkillPicker(
        ctx,
        (skill) =>
          submitPromptCommand(ctx, {
            name: skill.name,
            aliases: [],
            source: "skill",
          }, { skill }),
      );
      return {
        overlay: picker,
        ready: () => ctx.directoryCatalog?.ready("skills") ?? Promise.resolve(),
      };
    },
  });
}

/** One picker command, one activation command; skill identities never become slash rows. */
export function createSkillPicker(
  ctx: PromptContext,
  activate: (skill: SkillOption) => Promise<void>,
) {
  const [revision, setRevision] = createSignal(0);
  let picker: ListPickerControl | undefined, anchor: HTMLDivElement | undefined;
  const values = () => {
    revision();
    return ctx.directoryCatalog?.state.catalog?.values;
  };
  const choices = () =>
    skillChoices(
      values()?.skills?.value ?? [],
      values()?.commands?.value ?? [],
    );
  const enabled = () =>
    ctx.active() && ctx.props.connected && !ctx.props.suspended &&
    ctx.supports("commands");
  ownedCommand(ctx, {
    id: "skill.choose",
    title: "Choose skill",
    category: "Prompt",
    enabled,
    run: () => {
      if (!anchor || !picker) throw new Error("Skill picker is not mounted");
      const rect = anchor.getBoundingClientRect();
      picker.open({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        origin: anchor,
        focus: ctx.focus,
      });
    },
  });
  ownedCommand(ctx, {
    id: "skill.activate",
    title: "Activate skill",
    category: "Prompt",
    arguments: {
      type: "object",
      properties: {
        name: { type: "string" },
        id: { type: "string", optional: true },
      },
    },
    availability: (_context, skill?: SkillOption) => {
      if (!enabled()) {
        return { available: false, reason: "Session is not connected" };
      }
      const choice = choices().find((choice) =>
        skill?.id ? choice.id === skill.id : choice.name === skill?.name
      );
      return choice?.unavailable
        ? { available: false, reason: choice.unavailable }
        : choice
        ? { available: true }
        : { available: false, reason: "That skill is no longer available" };
    },
    run: (_context, skill: SkillOption) => activate(skill),
  });
  ctx.mount(() =>
    ctx.directoryCatalog?.subscribe(() => setRevision((value) => value + 1))
  );
  return () => (
    <div
      class="otk-skill-anchor"
      ref={(element) => {
        anchor = element;
      }}
    >
      <ListPicker<SkillOption>
        label="Skills"
        class="otk-skills-picker"
        header={<h3 class="otk-picker-heading otk-control-label">Skills</h3>}
        search="Search skills"
        groups={[{
          key: "skills",
          items: choices().map((skill) => ({
            key: skill.id ?? skill.name,
            value: skill,
            label: skill.name,
            description: skill.description,
            unavailable: skill.unavailable,
          })),
        }]}
        loading={!values()?.skills || values()?.skills?.state === "digesting"}
        error={values()?.skills?.state === "unavailable"
          ? "Skills are unavailable"
          : undefined}
        status={
          <>
            <Show
              when={!values()?.skills ||
                values()?.skills?.state === "digesting"}
            >
              <p class="otk-picker-status" role="status">Loading skills...</p>
            </Show>
            <Show when={values()?.skills?.state === "unavailable"}>
              <p class="otk-picker-status" role="alert">
                Skills are unavailable
              </p>
            </Show>
            <div class="otk-picker-status">
              <button
                type="button"
                onClick={() =>
                  void ctx.directoryCatalog?.refresh().catch(ctx.fail)}
              >
                Refresh
              </button>
            </div>
          </>
        }
        onOpen={() =>
          void ctx.directoryCatalog?.ready("skills").catch(ctx.fail)}
        control={(control) => {
          picker = control;
        }}
        onPick={(skill) =>
          void ctx.commands.run("skill.activate", {
            name: skill.name,
            ...(skill.id ? { id: skill.id } : {}),
          }).catch(ctx.fail)}
        focusAfterPick={ctx.focus}
      />
    </div>
  );
}
