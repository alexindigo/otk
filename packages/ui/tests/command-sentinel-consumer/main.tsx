// SPDX-License-Identifier: LGPL-3.0-only
import { render } from "@solidjs/web";
import { CommandHub } from "@otk/client";
import { CommandProvider } from "../../keyboard/context.tsx";
import Palette from "../../components/Palette.tsx";
import { registerSlashPrompt } from "../../features/prompt/slash.ts";
import { type PromptContext, PromptRegistry } from "../../registries/prompt.ts";

const commands = new CommandHub();
const prompt = new PromptRegistry();
registerSlashPrompt(prompt);
const releases: (() => void)[] = [];
const ctx = {
  commands,
  own: (release: () => void) => releases.push(release),
  mount: (setup: () => void | (() => void)) => {
    const release = setup();
    if (release) releases.push(release);
  },
  props: { connected: false },
  active: () => true,
} as unknown as PromptContext;
const slash = prompt.create(ctx)[0].source!;
render(() => (
  <CommandProvider commands={commands}>
    <Palette onClose={() => {}} />
  </CommandProvider>
), document.getElementById("app")!);
const name = crypto.randomUUID();
// Register AFTER both consumers exist, with no surface-specific metadata.
commands.register({
  id: name,
  title: name,
  category: "Sentinel",
  run: () => {},
});
const options = await slash.options({ start: 0, end: 1, query: name });
const result = document.createElement("output");
result.dataset.sentinel = name;
result.textContent = JSON.stringify(
  options.map((option) => option.command?.name),
);
document.body.append(result);
