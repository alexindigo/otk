// SPDX-License-Identifier: LGPL-3.0-only
import "./WorkLog.css" with { type: "text" };
import { createSignal, type Element } from "solid-js";
import { ownedAction } from "../keyboard/context.tsx";
import { elapsed, type WorkTime } from "./work-log.ts";
import { ChevronIcon } from "./ChromeIcons.tsx";

export default function WorkLog(
  props: { time: WorkTime; children: Element },
): Element {
  const [open, setOpen] = createSignal(true);
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
        <span class="otk-control-label" title={label()}>
          {label()}
        </span>
        <span class="otk-work-rule" aria-hidden="true" />
      </button>
      <div class="otk-work-body" hidden={!open()}>{props.children}</div>
    </section>
  );
}
