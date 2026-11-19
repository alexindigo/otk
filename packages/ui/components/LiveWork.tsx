// SPDX-License-Identifier: LGPL-3.0-only
import "./LiveWork.css" with { type: "text" };
import { createSignal, For, onCleanup, Show } from "solid-js";
import { duration, type RunningWork, runningWorkLabel } from "@otk/client";
import EntityPill from "./EntityPill.tsx";
import StatusLight from "./StatusLight.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
import Popover, { type PopoverControl } from "./surface/Popover.tsx";

/** One quiet control; data and actions belong to the session composition. */
export default function LiveWork(props: {
  items: readonly RunningWork[];
  onOpen(id: string): void;
  onStop?(id: string): Promise<void>;
  onError(error: unknown): void;
}): import("solid-js").Element {
  const [now, setNow] = createSignal(Date.now());
  const [stopping, setStopping] = createSignal<ReadonlySet<string>>(new Set());
  let timer: ReturnType<typeof setInterval> | undefined;
  let popover: PopoverControl | undefined;
  const stopClock = () => clearInterval(timer);
  onCleanup(stopClock);
  const open = (id: string) => {
    popover?.close();
    props.onOpen(id);
  };
  const stop = async (item: RunningWork) => {
    if (!props.onStop || stopping().has(item.id)) return;
    setStopping(new Set([...stopping(), item.id]));
    try {
      await props.onStop(item.sessionID);
    } catch (error) {
      props.onError(error);
    } finally {
      setStopping(new Set([...stopping()].filter((id) => id !== item.id)));
    }
  };
  return (
    <Show when={props.items.length}>
      <Popover
        class="otk-live-work"
        triggerClass="otk-live-work-trigger otk-pill"
        label="Running work"
        triggerLabel={`Running work: ${runningWorkLabel(props.items)}`}
        title="Running work"
        size="content"
        control={(control) => popover = control}
        onOpen={() => {
          stopClock();
          setNow(Date.now());
          timer = setInterval(() => setNow(Date.now()), 1000);
        }}
        onClose={stopClock}
        trigger={
          <>
            <StatusLight small state="working" />
            <span class="otk-control-label">
              {runningWorkLabel(props.items)}
            </span>
          </>
        }
      >
        <ScrollRegion
          class="otk-live-work-list"
          role="list"
          aria-label="Running work"
        >
          <For each={props.items} keyed={(item) => item.id}>
            {(item) => (
              <div
                class="otk-live-work-item"
                role="listitem"
                data-running-work={item().id}
              >
                <div class="otk-live-work-identity">
                  <EntityPill
                    label={item().label}
                    sessionID={item().kind === "helper"
                      ? item().sessionID
                      : undefined}
                    onOpen={item().kind === "helper" ? open : undefined}
                  />
                  <span
                    class="otk-live-work-title otk-control-label"
                    title={item().title}
                  >
                    {item().title}
                  </span>
                </div>
                <span class="otk-live-work-elapsed" aria-label="Elapsed time">
                  {item().startedAt === undefined
                    ? "Time unknown"
                    : duration(Math.max(0, now() - item().startedAt!))}
                </span>
                <div class="otk-live-work-actions">
                  <Show when={item().kind === "helper"}>
                    <button
                      type="button"
                      class="otk-pill"
                      onClick={() => open(item().sessionID)}
                    >
                      Open
                    </button>
                    <Show when={props.onStop && !stopping().has(item().id)}>
                      <button
                        type="button"
                        class="otk-pill"
                        onClick={() => void stop(item())}
                      >
                        Stop
                      </button>
                    </Show>
                    <Show when={stopping().has(item().id)}>
                      <span role="status">Stopping...</span>
                    </Show>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </ScrollRegion>
      </Popover>
    </Show>
  );
}
