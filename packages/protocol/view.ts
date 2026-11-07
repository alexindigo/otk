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
  query?: string;
}
