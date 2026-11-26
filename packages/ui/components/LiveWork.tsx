// SPDX-License-Identifier: LGPL-3.0-only
import "./LiveWork.css" with { type: "text" };
import { createSignal, For, onCleanup } from "solid-js";
import { countLabel, elapsed, unknownTime } from "@otk/client";
import type { RunningShells } from "@otk/protocol";
import TimeValue from "./TimeValue.tsx";
import TimeText from "./TimeText.tsx";
import EntityPill from "./EntityPill.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import LiveCount, { LIVE_COUNT_TRIGGER } from "./LiveCount.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
import Popover from "./surface/Popover.tsx";
import { useOptionalSessionPorts } from "../registries/session.tsx";
import { scopedEntityFacts } from "../entity-facts.ts";

/** Shell work only. D67's sub-session inventory has one separate Menu view. */
export default function LiveWork(
  props: { shells: RunningShells; sessionID: string },
) {
  const session = useOptionalSessionPorts();
  const label = () => countLabel(props.shells.count, "shell");
  const [now, setNow] = createSignal(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => clearInterval(timer);
  onCleanup(stop);
  return (
    <Popover
      class="otk-live-work"
      triggerClass={`${LIVE_COUNT_TRIGGER} otk-live-work-trigger`}
      label="Running shells"
      triggerLabel={`Running work: ${label()}`}
      title="Running shells"
      size="content"
      place="bounds-end"
      onOpen={() => {
        stop();
        setNow(Date.now());
        timer = setInterval(() => setNow(Date.now()), 1000);
      }}
      onClose={stop}
      trigger={
        <LiveCount
          parts={[{
            id: "shells",
            count: props.shells.count,
            lamp: props.shells,
          }]}
        />
      }
    >
      <ScrollRegion
        class="otk-live-work-list"
        role="list"
        aria-label="Running shells"
      >
        <For each={props.shells.items} keyed={(item) => item.id}>
          {(item) => (
            <div
              class="otk-live-work-item"
              role="listitem"
              data-running-work={`shell/${item().id}`}
            >
              <EntityPill
                label={item().label}
                facts={scopedEntityFacts(session, {
                  sessionID: props.sessionID,
                })}
              />
              <span
                class="otk-live-work-title otk-control-label"
                title={item().title}
              >
                {item().title}
              </span>
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
                  : (
                    <>
                      Running for{" "}
                      <TimeText time={elapsed(now() - item().startedAt!)} />
                    </>
                  )}
              </ChromeMeta>
            </div>
          )}
        </For>
      </ScrollRegion>
    </Popover>
  );
}
