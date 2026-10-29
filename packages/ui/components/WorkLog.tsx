// SPDX-License-Identifier: LGPL-3.0-only
import "./WorkLog.css" with { type: "text" };
import { type Element, Show } from "solid-js";
import { retainedDisclosure } from "../features/transcript-context.tsx";
import { ownedAction } from "../keyboard/context.tsx";
import { elapsed, type WorkTime } from "./work-log.ts";
import { ChevronIcon } from "./ChromeIcons.tsx";
import DividerLabel from "./DividerLabel.tsx";

export default function WorkLog(
  props: { time: WorkTime; identity?: string; body(): Element },
): Element {
  const [expanded, setOpen] = retainedDisclosure("work:" + props.identity);
  const open = () => expanded() ?? true;
  const toggle = ownedAction("work.toggle", () => setOpen(!open()));
  const label = () =>
    props.time.start !== undefined && props.time.end !== undefined
      ? `Worked for ${elapsed(props.time.start, props.time.end)}`
      : "Work log";
  return (
    <section class="otk-work-log">
      <button
        class="otk-work-fold"
        type="button"
        aria-expanded={open() ? "true" : "false"}
        onClick={() => void toggle()}
      >
        <ChevronIcon class="otk-work-chevron" />
        <DividerLabel label={label()} />
      </button>
      <Show when={open()}>
        <div class="otk-work-body">{props.body()}</div>
      </Show>
    </section>
  );
}
