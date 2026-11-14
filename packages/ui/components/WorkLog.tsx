// SPDX-License-Identifier: LGPL-3.0-only
import "./WorkLog.css" with { type: "text" };
import { type Element, Show } from "solid-js";
import { retainedDisclosure } from "../features/transcript-context.tsx";
import { ownedAction } from "../keyboard/context.tsx";
import { timingExplanation, workingTime } from "./work-log.ts";
import type { TurnTiming } from "@otk/protocol";
import { ChevronIcon } from "./ChromeIcons.tsx";
import DividerLabel from "./DividerLabel.tsx";
import type { Preferences } from "@otk/protocol";

export default function WorkLog(
  props: {
    time?: TurnTiming;
    identity?: string;
    prefs?: Preferences;
    required?: boolean;
    body(): Element;
  },
): Element {
  const [open, setOpen] = retainedDisclosure(
    "work:" + props.identity,
    "work",
    () => props.prefs ?? {},
    undefined,
    () => !!props.required,
  );
  const toggle = ownedAction("work.toggle", () => setOpen(!open()));
  const label = () => workingTime(props.time) ?? "Work log";
  return (
    <section class="otk-work-log">
      <button
        class="otk-work-fold"
        type="button"
        aria-expanded={open() ? "true" : "false"}
        title={timingExplanation(props.time)}
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
