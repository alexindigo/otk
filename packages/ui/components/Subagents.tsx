// SPDX-License-Identifier: LGPL-3.0-only
import {
  createMemo,
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import {
  type ActionControl,
  type EntityStateStore,
  helperClock,
  helperCountParts,
  helperCountsLabel,
  helperDisposition,
  lamp,
  type LiveWorkOwner,
  unknownTime,
} from "@otk/client";
import {
  entityKey,
  type HelperDisposition,
  type TaskHelpers,
} from "@otk/protocol";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
import { scopedEntityFacts } from "../entity-facts.ts";
import { useOptionalSessionPorts } from "../registries/session.tsx";
import ActionButton from "./ActionButton.tsx";
import StatusLight from "./StatusLight.tsx";
import LiveCount from "./LiveCount.tsx";
import { StopIcon } from "./ChromeIcons.tsx";
import SelectionContent from "./SelectionContent.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import EntityPill from "./EntityPill.tsx";
import TimeValue from "./TimeValue.tsx";
import TimeText from "./TimeText.tsx";
import Menu from "./surface/Menu.tsx";
import type { PopoverControl } from "./surface/Popover.tsx";
import { selection } from "./selection.ts";
import "./Subagents.css" with { type: "text" };

/** D67: the composer's single view of the entity owner's D66 helper inventory. */
export default function Subagents(
  props: {
    helpers?: TaskHelpers;
    taskKey?: string;
    current: string;
    entities?: EntityStateStore;
    title(id: string): string;
    agent(id: string): string | undefined;
    openAction(id: string): ActionControl;
    owner?: LiveWorkOwner;
  },
) {
  const session = useOptionalSessionPorts();
  const helpers = () => props.helpers;
  const entities = () => props.entities;
  const grouped = createMemo(() => {
    const byState: Record<HelperDisposition, string[]> = {
      running: [],
      needsYou: [],
      notReturned: [],
    };
    const store = entities();
    if (store) {
      for (const id of helpers()?.ids ?? []) {
        const disposition = helperDisposition(store, entityKey("session", id));
        if (disposition) byState[disposition].push(id);
      }
    }
    const counts = helpers()?.counts;
    return counts
      ? helperCountParts(counts).map((group) => ({
        ...group,
        ids: byState[group.kind],
      }))
      : [];
  });
  const headingID = createUniqueId();
  const [now, setNow] = createSignal(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => clearInterval(timer);
  onCleanup(stop);
  const [revision, setRevision] = createSignal(0);
  onSettled(() =>
    props.owner?.subscribe(() => setRevision((value) => value + 1))
  );
  const workID = (id: string) => `helper/${id}`;
  const stopping = (id: string) => {
    revision();
    return props.owner?.stopping(workID(id));
  };
  const ports = useCommandPorts();
  const stopCommand = `subagents.stop@${createUniqueId()}`;
  ownedCommand(ports, {
    id: stopCommand,
    title: "Stop subagent",
    category: "Session",
    scope: "control",
    arguments: { type: "string" },
    availability: (_context, id: string) =>
      props.owner?.canStop(workID(id)) ? { available: true } : {
        available: false,
        reason: "Subagent cannot be stopped",
        hidden: true,
      },
    run: (_context, id: string) => props.owner?.stop(workID(id)),
  });
  const stopAction = (id: string) =>
    ports.commands.control(stopCommand, id, {
      target: { label: props.title(id) },
      // The stop request has settled; the lamp still follows native work evidence.
      shown: () => true,
      unshown: "The stop request did not complete.",
      recovery:
        "Check the subagent and try stopping it again if it is still running",
    });
  let menu: PopoverControl | undefined;
  return (
    <Show when={helpers()?.ids.length ? helpers() : undefined}>
      {(publication) => (
        <Menu
          class="otk-subagents"
          place="bounds-end"
          triggerClass="otk-subagents-trigger"
          label="Subagents"
          title="Subagents"
          triggerLabel={`Subagents: ${
            helperCountsLabel(publication().counts, "spoken")
          }`}
          size="fit"
          control={(control) => menu = control}
          dismissOnAction={false}
          onOpen={() => {
            stop();
            setNow(Date.now());
            timer = setInterval(() => setNow(Date.now()), 1000);
          }}
          onClose={stop}
          trigger={
            <LiveCount
              entities={entities()}
              lampKey={props.taskKey}
              label={helperCountsLabel(publication().counts)}
              compact={grouped().map((group) => ({
                id: group.kind,
                count: group.count,
                lampKey: group.ids[0]
                  ? entityKey("session", group.ids[0])
                  : undefined,
              }))}
            />
          }
        >
          <div class="otk-subagent-list" role="presentation">
            <For each={grouped()} keyed={(group) => group.kind}>
              {(group) => (
                <div
                  class="otk-subagent-group"
                  role="group"
                  aria-labelledby={`${headingID}-${group().kind}`}
                >
                  <div class="otk-subagent-heading">
                    <ChromeMeta id={`${headingID}-${group().kind}`}>
                      {group().title} {group().count}
                    </ChromeMeta>
                  </div>
                  <For each={group().ids}>
                    {(id) => {
                      const key = entityKey("session", id);
                      const evidence = () => {
                        const store = entities();
                        return store && !store.isStale
                          ? store.get(key)
                          : undefined;
                      };
                      const clock = createMemo(() =>
                        helperClock(evidence(), now())
                      );
                      return (
                        <div class="otk-subagent-row" data-subagent={id}>
                          <div class="otk-subagent-navigation">
                            <ActionButton
                              action={props.openAction(id)}
                              selection={selection({
                                class: "otk-subagent-name",
                                kind: "current",
                                selected: props.current === id,
                              })}
                              attributes={{
                                "data-otk-selection": "vertical",
                              }}
                              onShown={() => menu?.close()}
                            >
                              <SelectionContent>
                                <StatusLight
                                  small
                                  state={lamp(entities(), key)}
                                />
                                <span
                                  class="otk-control-label"
                                  title={props.title(id)}
                                >
                                  {props.title(id)}
                                </span>
                              </SelectionContent>
                            </ActionButton>
                          </div>
                          <div class="otk-subagent-agent">
                            <Show when={props.agent(id)}>
                              {(agent) => (
                                <EntityPill
                                  label={agent()}
                                  facts={scopedEntityFacts(session, {
                                    sessionID: id,
                                  })}
                                />
                              )}
                            </Show>
                          </div>
                          <ChromeMeta
                            class="otk-subagent-time"
                            aria-label={group().kind === "needsYou"
                              ? "Waiting for you"
                              : undefined}
                          >
                            <Show
                              when={clock()}
                              fallback={
                                <TimeValue
                                  value={unknownTime(
                                    "The native execution start and finish times are not available.",
                                  )}
                                />
                              }
                            >
                              {(value) => (
                                <TimeText
                                  time={value().time}
                                  suffix={value().ago ? "ago" : undefined}
                                />
                              )}
                            </Show>
                          </ChromeMeta>
                          <div class="otk-subagent-stop">
                            <Show when={group().kind === "running"}>
                              <ActionButton
                                class="otk-icon-button otk-subagent-stop-button"
                                action={stopAction(id)}
                                label={`Stop ${props.title(id)}`}
                                title={`Stop ${props.title(id)}`}
                                pendingLabel="Stopping..."
                                busy={stopping(id)}
                              >
                                <StopIcon />
                              </ActionButton>
                            </Show>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Menu>
      )}
    </Show>
  );
}
