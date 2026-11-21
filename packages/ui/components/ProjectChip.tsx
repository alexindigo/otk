// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, type Element, Show } from "solid-js";
import {
  errorFeedback,
  type FailureValue,
  failureValue,
  projectName,
} from "@otk/client";
import type { CatalogProject, CatalogRepository } from "@otk/protocol";
import { copyText } from "../clipboard.ts";
import Menu from "./surface/Menu.tsx";
import type { PopoverControl } from "./surface/Popover.tsx";
import FeedbackStatus from "./FeedbackStatus.tsx";
import { ChevronIcon, CopyIcon, SettingsIcon } from "./ChromeIcons.tsx";
import Icon from "./Icon.tsx";
import ControlValue, { ControlIcon } from "./ControlValue.tsx";
import "./ProjectChip.css" with { type: "text" };

export function ProjectAvatar(
  props: {
    name: string;
    icon?: string;
    color?: string;
    size?: "control" | "compact";
  },
): Element {
  const [failed, setFailed] = createSignal<string>();
  const initial = () =>
    new Intl.Segmenter(undefined, { granularity: "grapheme" })
      .segment(props.name.trim())[Symbol.iterator]().next().value?.segment
      .toLocaleUpperCase() ?? "";
  return (
    <span
      class={["otk-project-avatar", {
        "has-color": !!props.color,
        "is-control-size": props.size === "control",
        "is-compact-size": props.size === "compact",
      }]}
      style={{ "--project-color": props.color }}
      aria-hidden="true"
    >
      <Show when={props.icon && props.icon !== failed()} fallback={initial()}>
        <img src={props.icon} alt="" onError={() => setFailed(props.icon)} />
      </Show>
    </span>
  );
}
const FolderIcon = () => (
  <Icon>
    <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  </Icon>
);
const BranchIcon = () => (
  <Icon>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="5" r="2" />
    <path d="M6 7v10M18 7v2a4 4 0 0 1-4 4H6" />
  </Icon>
);
const MachineIcon = () => (
  <Icon>
    <rect x="3" y="3" width="18" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </Icon>
);
const ChangesIcon = () => (
  <Icon>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6ZM14 2v6h6M8 13h8M8 17h5" />
  </Icon>
);

/** Every fact/action has the same leading icon and text tracks. */
function ProjectMenuRow(
  props: { icon: () => Element; label: string; accessory?: Element },
): Element {
  return (
    <>
      <ControlIcon>{props.icon()}</ControlIcon>
      <ControlValue accessory={props.accessory}>
        <span class="otk-control-label" title={props.label}>{props.label}</span>
      </ControlValue>
    </>
  );
}

/** Data-only location presentation. Native vocabulary is supplied by the harness. */
export default function ProjectChip(props: {
  directory: string;
  project?: CatalogProject;
  repository?: CatalogRepository;
  onOpen?(): void;
  onEdit?(ready: () => void): void;
  feedback?: FailureValue;
}): Element {
  const name = () =>
    props.project?.name || projectName(props.project?.root ?? props.directory);
  const [error, setError] = createSignal<FailureValue>("");
  let menu!: PopoverControl;
  const copy = (text: string) => {
    setError("");
    void copyText(text).then(() => menu.close()).catch((cause) =>
      setError(failureValue(cause))
    );
  };
  const avatar = () => (
    <ProjectAvatar
      name={name()}
      icon={props.project?.icon}
      color={props.project?.color}
    />
  );
  const submenu = (
    label: string,
    icon: () => Element,
    action: string,
    value: string,
  ) => (
    <Menu
      label={label}
      class="otk-project-chip-submenu"
      triggerClass="otk-project-chip-menu-row otk-project-chip-submenu-trigger"
      trigger={
        <ProjectMenuRow icon={icon} label={label} accessory={<ChevronIcon />} />
      }
    >
      <button
        type="button"
        class="otk-project-chip-menu-row"
        onClick={() => copy(value)}
      >
        <ProjectMenuRow icon={CopyIcon} label={action} />
      </button>
    </Menu>
  );
  return (
    <span class="otk-project-chip">
      <Menu
        label={`Project: ${name()}`}
        class="otk-project-chip-menu"
        triggerClass="otk-project-chip-trigger"
        trigger={
          <>
            {avatar()}
            <span class="otk-control-label">{name()}</span>
          </>
        }
        control={(control) => menu = control}
        dismissOnAction={false}
        onOpen={props.onOpen}
        status={
          <Show when={error() || props.feedback}>
            <FeedbackStatus
              compact
              feedback={errorFeedback(error() || props.feedback)}
            />
          </Show>
        }
      >
        <div class="otk-project-chip-menu-content">
          <h2 class="otk-project-chip-menu-heading" title={name()}>
            {avatar()}
            <span class="otk-control-label">{name()}</span>
          </h2>
          <Show when={props.project?.repository}>
            {(label) => (
              <div class="otk-project-chip-menu-row">
                <ProjectMenuRow icon={FolderIcon} label={label()} />
              </div>
            )}
          </Show>
          <Show when={props.repository?.branch}>
            {(branch) => submenu(branch(), BranchIcon, "Copy branch", branch())}
          </Show>
          <Show when={props.repository?.changes}>
            {(changes) => (
              <div class="otk-project-chip-menu-row">
                <ProjectMenuRow icon={ChangesIcon} label={changes()} />
              </div>
            )}
          </Show>
          <Show when={props.project?.machine}>
            {(label) => (
              <div class="otk-project-chip-menu-row">
                <ProjectMenuRow icon={MachineIcon} label={label()} />
              </div>
            )}
          </Show>
          <Show when={props.directory}>
            {(directory) =>
              submenu(directory(), FolderIcon, "Copy path", directory())}
          </Show>
          <Show when={props.onEdit}>
            <button
              type="button"
              class="otk-project-chip-menu-row"
              onClick={() => {
                props.onEdit?.(() => menu.close());
              }}
            >
              <ProjectMenuRow icon={SettingsIcon} label="Edit project" />
            </button>
          </Show>
        </div>
      </Menu>
    </span>
  );
}
