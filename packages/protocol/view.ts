// SPDX-License-Identifier: LGPL-3.0-only
/** One socket's replaceable demand. Epochs fence asynchronous scope acquisition. */
export interface ViewLease {
  epoch: number;
  directory?: string;
  selected?: string;
  /** Server-owned first-page settlement; clients acknowledge through view.settled. */
  pageSettled?: boolean;
  crumbs: string[];
  rows: string[];
  /** Identities referenced by mounted transcript links, not sidebar rows. */
  references?: string[];
  /** At most two non-presentational identities for browser history labels. */
  historyNeighbors?: string[];
  query?: string;
  /** Host-sidecar preference projected onto this connection's task view. */
  tasksFollowParent?: boolean;
}
