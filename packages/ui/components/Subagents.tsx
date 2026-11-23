// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import {
  countLabel,
  type LiveWorkOwner,
  runningWorkElapsed,
  type TrailCrumb,
  type TrailModel,
  unknownTime,
} from "@otk/client";
import StatusLight from "./StatusLight.tsx";
import SelectionContent from "./SelectionContent.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import TimeValue from "./TimeValue.tsx";
import Menu from "./surface/Menu.tsx";
import type { PopoverControl } from "./surface/Popover.tsx";
import { selection } from "./selection.ts";
import "./Subagents.css" with { type: "text" };

/** D67: the composer's single view of the trail owner's D66 helper inventory. */
export default function Subagents(
  props: {
    model: TrailModel;
    title(id: string): string;
    onOpen(id: string): void;
    owner?: LiveWorkOwner;
    onError(error: unknown): void;
  },
) {
  const [now, setNow] = createSignal(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => clearInterval(timer);
  onCleanup(stop);
  const [revision, setRevision] = createSignal(0);
  onSettled(() =>
    props.owner?.subscribe(() => setRevision((value) => value + 1))
  );
  const stopping = (id: string) => {
    revision();
    return props.owner?.stopping(`helper/${id}`);
  };
  let menu: PopoverControl | undefined;
  const open = (id: string) => {
    menu?.close();
    props.onOpen(id);
  };
  return (
    <Show when={props.model.helpers.length}>
      <Menu
        class="otk-subagents"
        triggerClass="otk-subagents-trigger"
        label="Subagents"
        control={(control) => menu = control}
        dismissOnAction={false}
        onOpen={() => {
          stop();
          setNow(Date.now());
          timer = setInterval(() => setNow(Date.now()), 1000);
        }}
        onClose={stop}
        trigger={
          <>
            <StatusLight small state={props.model.status} />
            <ChromeMeta>
              {countLabel(props.model.helpers.length, "subagent")}
            </ChromeMeta>
          </>
        }
      >
        <For each={props.model.helpers} keyed={(item) => item.id}>
          {(item: () => TrailCrumb) => (
            <div
              class="otk-subagent-row"
              data-subagent={item().id}
              onClick={() => open(item().id)}
            >
              <button
                type="button"
                data-otk-selection="vertical"
                {...selection({
                  class: "otk-subagent-name",
                  kind: "current",
                  selected: item().id === props.model.path.at(-1)?.id,
                })}
              >
                <SelectionContent>
                  <StatusLight small state={item().status} />
                  <span
                    class="otk-control-label"
                    title={props.title(item().id)}
                  >
                    {props.title(item().id)}
                  </span>
                </SelectionContent>
              </button>
              <Show when={props.owner?.canStop(`helper/${item().id}`)}>
                <Show
                  when={stopping(item().id)}
                  fallback={
                    <button
                      type="button"
                      class="otk-subagent-stop"
                      aria-label={`Stop ${props.title(item().id)}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void props.owner?.stop(`helper/${item().id}`).catch(
                          props.onError,
                        );
                      }}
                    >
                      Stop
                    </button>
                  }
                >
                  <span class="otk-subagent-stop" role="status">
                    Stopping...
                  </span>
                </Show>
              </Show>
              <ChromeMeta class="otk-subagent-time" aria-label="Running time">
                {item().run
                  ? runningWorkElapsed(
                    (item().run!.endedAt ?? now()) - item().run!.startedAt,
                  )
                  : (
                    <TimeValue
                      value={unknownTime(
                        "The native execution start time is not available.",
                      )}
                    />
                  )}
              </ChromeMeta>
            </div>
          )}
        </For>
      </Menu>
    </Show>
  );
}
