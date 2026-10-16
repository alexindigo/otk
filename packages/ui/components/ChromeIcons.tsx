// SPDX-License-Identifier: LGPL-3.0-only
import type { Element } from "solid-js";
function Icon(props: { children: Element }): Element {
  return (
    <svg
      class="otk-chrome-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}
export const PanelLeftIcon = () => (
  <Icon>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18" />
  </Icon>
);
export const PanelRightIcon = () => (
  <Icon>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M15 3v18" />
  </Icon>
);
export const PlusIcon = () => (
  <Icon>
    <path d="M5 12h14M12 5v14" />
  </Icon>
);
export const SearchIcon = () => (
  <Icon>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);
export const SettingsIcon = () => (
  <Icon>
    <path d="M20 7h-9M14 17H5" />
    <circle cx="17" cy="17" r="3" />
    <circle cx="7" cy="7" r="3" />
  </Icon>
);
export const KeyboardIcon = () => (
  <Icon>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
  </Icon>
);
export const ChevronIcon = () => (
  <Icon>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);
export const SessionsIcon = () => (
  <Icon>
    <path d="M21 12h-8M21 6H8M21 18h-8M3 6v4a2 2 0 0 0 2 2h3M3 10v6a2 2 0 0 0 2 2h3" />
  </Icon>
);
