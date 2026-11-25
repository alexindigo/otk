// SPDX-License-Identifier: LGPL-3.0-only
import {
  createSignal,
  createUniqueId,
  For,
  onCleanup,
  onSettled,
  Show,
} from "solid-js";
import {
  type ActionControl,
  countLabel,
  elapsed,
  type EntityStateStore,
  lamp,
  type LiveWorkOwner,
  sessionEvidence,
  taskHelpers,
  type TrailModel,
  unknownTime,
} from "@otk/client";
import { entityKey } from "@otk/protocol";
import { ownedCommand, useCommandPorts } from "../keyboard/context.tsx";
import ActionButton from "./ActionButton.tsx";
import StatusLight from "./StatusLight.tsx";
import SelectionContent from "./SelectionContent.tsx";
import ChromeMeta from "./ChromeMeta.tsx";
import TimeValue from "./TimeValue.tsx";
import TimeText from "./TimeText.tsx";
import Menu from "./surface/Menu.tsx";
import type { PopoverControl } from "./surface/Popover.tsx";
import { selection } from "./selection.ts";
import "./Subagents.css" with { type: "text" };

/** D67: the composer's single view of the entity owner's D66 helper inventory. */
export default function Subagents(
  props: {
    trail: TrailModel;
    entities?: EntityStateStore;
    title(id: string): string;
    openAction(id: string): ActionControl;
    owner?: LiveWorkOwner;
  },
) {
  const ids = () =>
    props.entities && taskHelpers(props.entities, props.trail.task)?.ids;
  const entities = () => props.entities;
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
    <Show when={ids()?.length ?? 0}>
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
            <StatusLight small state={lamp(entities(), props.trail.task)} />
            <ChromeMeta>
              {countLabel(ids()?.length ?? 0, "subagent")}
            </ChromeMeta>
          </>
        }
      >
        <For each={ids() ?? []}>
          {(id) => {
            const key = () => entityKey("session", id);
            const run = () =>
              props.entities && sessionEvidence(props.entities, key())?.run;
            const selected = () =>
              selection({
                class: "otk-subagent-name",
                kind: "current",
                selected: id === props.trail.path.at(-1)?.id,
              });
            return (
              <div
                class="otk-subagent-row"
                data-subagent={id}
              >
                <div class="otk-subagent-navigation">
                  <ActionButton
                    action={props.openAction(id)}
                    selection={selected()}
                    attributes={{ "data-otk-selection": "vertical" }}
                    onShown={() => menu?.close()}
                  >
                    <SelectionContent>
                      <StatusLight small state={lamp(entities(), key())} />
                      <span
                        class="otk-control-label"
                        title={props.title(id)}
                      >
                        {props.title(id)}
                      </span>
                    </SelectionContent>
                  </ActionButton>
                </div>
                <div
                  class="otk-subagent-stop"
                  hidden={!props.owner?.canStop(workID(id)) &&
                    !stopping(id)}
                >
                  <ActionButton
                    action={stopAction(id)}
                    label={`Stop ${props.title(id)}`}
                    pendingLabel="Stopping..."
                    busy={stopping(id)}
                  >
                    Stop
                  </ActionButton>
                </div>
                <ChromeMeta class="otk-subagent-time" aria-label="Running time">
                  {run()
                    ? (
                      <TimeText
                        time={elapsed(
                          (run()!.endedAt ?? now()) - run()!.startedAt,
                        )}
                      />
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
            );
          }}
        </For>
      </Menu>
    </Show>
  );
}
