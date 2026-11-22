// SPDX-License-Identifier: LGPL-3.0-only
import "./LiveWork.css" with { type: "text" };
import { createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import {
  type LiveWorkOwner,
  type RunningWork,
  runningWorkElapsed,
  runningWorkLabel,
  unknownTime,
} from "@otk/client";
import TimeValue from "./TimeValue.tsx";
import EntityPill from "./EntityPill.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import StatusLight from "./StatusLight.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
import Popover, { type PopoverControl } from "./surface/Popover.tsx";
import { useOptionalSessionPorts } from "../registries/session.tsx";
import { scopedEntityFacts } from "../entity-facts.ts";

/** One quiet control; data and actions belong to the session composition. */
export default function LiveWork(props: {
  items: readonly RunningWork[];
  onOpen(id: string): void;
  owner?: LiveWorkOwner;
  onError(error: unknown): void;
}): import("solid-js").Element {
  const [now, setNow] = createSignal(Date.now());
  const session = useOptionalSessionPorts();
  const sidecar = session?.failureTarget?.().sidecarId;
  const [revision, setRevision] = createSignal(0);
  onSettled(() =>
    props.owner?.subscribe(() => setRevision((value) => value + 1))
  );
  const stopping = (id: string) => {
    revision();
    return props.owner?.stopping(id);
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  let popover: PopoverControl | undefined;
  const stopClock = () => clearInterval(timer);
  onCleanup(stopClock);
  const open = (id: string) => {
    popover?.close();
    props.onOpen(id);
  };
  const stop = async (item: RunningWork) => {
    try {
      await props.owner?.stop(item.id);
    } catch (error) {
      props.onError(error);
    }
  };
  return (
    <Show when={props.items.length}>
      <Popover
        class="otk-live-work"
        triggerClass="otk-live-work-trigger"
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
            <ChromeMeta class="otk-control-label">
              {runningWorkLabel(props.items)}
            </ChromeMeta>
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
                class={["otk-live-work-item", {
                  "is-helper": item().kind === "helper",
                }]}
                role="listitem"
                data-running-work={item().id}
                onClick={() => {
                  if (item().kind === "helper") open(item().sessionID);
                }}
              >
                <StatusLight
                  small
                  attention={sidecar
                    ? { server: sidecar, session: item().sessionID }
                    : undefined}
                  state={session?.status?.(item().sessionID) === "blocked"
                    ? "blocked"
                    : "working"}
                />
                <span
                  class="otk-live-work-entity"
                  onClick={(event) => event.stopPropagation()}
                >
                  <EntityPill
                    label={item().label}
                    facts={scopedEntityFacts(session, {
                      sessionID: item().sessionID,
                    })}
                    onOpen={item().kind === "helper" ? open : undefined}
                  />
                </span>
                <Show
                  when={item().kind === "helper"}
                  fallback={
                    <span
                      class="otk-live-work-title otk-control-label"
                      title={item().title}
                    >
                      {item().title}
                    </span>
                  }
                >
                  <button
                    type="button"
                    class="otk-live-work-open otk-live-work-title otk-control-label"
                    aria-label={`Open ${item().label}: ${item().title}`}
                    title={item().title}
                    onClick={(event) => {
                      event.stopPropagation();
                      open(item().sessionID);
                    }}
                  >
                    {item().title}
                  </button>
                </Show>
                <ChromeMeta
                  class="otk-live-work-elapsed"
                  aria-label="Running for"
                >
                  {item().startedAt === undefined
                    ? (
                      <TimeValue
                        value={unknownTime(
                          "The native start time was not recorded.",
                        )}
                      />
                    )
                    : `Running for ${
                      runningWorkElapsed(now() - item().startedAt!)
                    }`}
                </ChromeMeta>
                <div
                  class="otk-live-work-actions"
                  onClick={(event) => event.stopPropagation()}
                >
                  <Show when={item().kind === "helper"}>
                    <Show
                      when={props.owner?.canStop(item().id) &&
                        !stopping(item().id)}
                    >
                      <button
                        type="button"
                        class="otk-pill"
                        onClick={() => void stop(item())}
                      >
                        Stop
                      </button>
                    </Show>
                    <Show when={stopping(item().id)}>
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
