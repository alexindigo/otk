// SPDX-License-Identifier: LGPL-3.0-only
import "./LiveWork.css" with { type: "text" };
import { createSignal, For, onCleanup, Show } from "solid-js";
import {
  createEntityStateStore,
  elapsed,
  type RunningWork,
  runningWorkLabel,
  unknownTime,
} from "@otk/client";
import { entityKey } from "@otk/protocol";
import TimeValue from "./TimeValue.tsx";
import TimeText from "./TimeText.tsx";
import EntityPill from "./EntityPill.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import LiveCount from "./LiveCount.tsx";
import ScrollRegion from "./ScrollRegion.tsx";
import Popover from "./surface/Popover.tsx";
import { useOptionalSessionPorts } from "../registries/session.tsx";
import { scopedEntityFacts } from "../entity-facts.ts";
const absent = createEntityStateStore({ read: () => undefined });

/** Shell work only. D67's sub-session inventory has one separate Menu view. */
export default function LiveWork(props: { items: readonly RunningWork[] }) {
  const session = useOptionalSessionPorts();
  const entities = () => session?.entities?.() ?? absent;
  const lampKey = () =>
    session?.workEntityKey?.() ??
      entityKey("session", session?.sessionID() ?? "");
  const shells = () => props.items.filter((item) => item.kind === "shell");
  const [now, setNow] = createSignal(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => clearInterval(timer);
  onCleanup(stop);
  return (
    <Show when={shells().length}>
      <Popover
        class="otk-live-work"
        triggerClass="otk-live-work-trigger"
        label="Running shells"
        triggerLabel={`Running work: ${runningWorkLabel(shells())}`}
        title="Running shells"
        size="content"
        onOpen={() => {
          stop();
          setNow(Date.now());
          timer = setInterval(() => setNow(Date.now()), 1000);
        }}
        onClose={stop}
        trigger={
          <LiveCount
            entities={entities()}
            lampKey={lampKey()}
            label={runningWorkLabel(shells())}
          />
        }
      >
        <ScrollRegion
          class="otk-live-work-list"
          role="list"
          aria-label="Running shells"
        >
          <For each={shells()} keyed={(item) => item.id}>
            {(item) => (
              <div
                class="otk-live-work-item"
                role="listitem"
                data-running-work={item().id}
              >
                <EntityPill
                  label={item().label}
                  facts={scopedEntityFacts(session, {
                    sessionID: item().sessionID,
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
    </Show>
  );
}
