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
export const ChevronDownIcon = () => (
  <Icon>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
export const StarIcon = (props: { filled: boolean }) => (
  <Icon>
    <path
      d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z"
      fill={props.filled ? "currentColor" : "none"}
    />
  </Icon>
);
export const SessionsIcon = () => (
  <Icon>
    <path d="M21 12h-8M21 6H8M21 18h-8M3 6v4a2 2 0 0 0 2 2h3M3 10v6a2 2 0 0 0 2 2h3" />
  </Icon>
);
export const ActivityIcon = () => (
  <Icon>
    <circle cx="12" cy="12" r="8" />
    <path d="M12 7v5l3 2" />
  </Icon>
);
export const ShieldCheckIcon = () => (
  <Icon>
    <path d="m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Z" />
    <path d="m8 12 3 3 5-6" />
  </Icon>
);
export const CopyIcon = () => (
  <Icon>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </Icon>
);
export const AttachIcon = () => (
  <Icon>
    <path d="m21 11-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.6 8.6a1.8 1.8 0 0 1-2.6-2.6L15 6.5" />
  </Icon>
);
export const SendIcon = () => (
  <Icon>
    <path d="m6 11 6-6 6 6M12 19V5" />
  </Icon>
);
export const PencilIcon = () => (
  <Icon>
    <path d="m16 4 4 4M3 21l5-1L21 7a2.8 2.8 0 0 0-4-4L4 16l-1 5Z" />
  </Icon>
);
