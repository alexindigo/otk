// SPDX-License-Identifier: LGPL-3.0-only
export interface HighlightToken {
  content: string;
  color?: string;
  fontStyle?: number;
}
export type HighlightRequest =
  | {
    id: number;
    block: number;
    lang: string;
    text: string;
    streaming: boolean;
  }
  | { dispose: number };
export type HighlightResult = {
  id: number;
  from: number;
  tokens: HighlightToken[];
  plain?: boolean;
  error?: string;
};
