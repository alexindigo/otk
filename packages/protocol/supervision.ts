// SPDX-License-Identifier: LGPL-3.0-only
/** Adapter-owned positive evidence. Absence is never proof of activity. */
export interface EvidenceInventory {
  keys: readonly string[];
  fresh: boolean;
}
export interface SupervisionEvidence {
  work?: EvidenceInventory;
  inputs?: EvidenceInventory;
  permissions?: EvidenceInventory;
  /** Monotone provider completion watermark, never an OTK observation clock. */
  terminal?: number;
}
export interface Supervision {
  state: "needsYou" | "working" | "finishedUnseen" | "none";
  terminal: number;
}
