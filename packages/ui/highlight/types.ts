// SPDX-License-Identifier: LGPL-3.0-only
export interface HighlightToken {
  content: string;
  color?: string;
  fontStyle?: number;
}
export interface HighlightRange {
  start: number;
  end: number;
}
export type HighlightRequest =
  | { type: "prepare"; id: number; block: number; lang: string; text?: string }
  | {
    type: "capture";
    id: number;
    block: number;
    generation: number;
    lang: string;
    text: string;
    streaming: boolean;
    focus?: HighlightRange[];
  }
  | {
    type: "focus";
    block: number;
    generation: number;
    ranges: HighlightRange[];
  }
  | { type: "cancel"; block: number; generation: number }
  | { type: "dispose"; block: number };
export interface HighlightChunk {
  from: number;
  tokens: HighlightToken[];
}
export interface HighlightInput {
  generation: number;
  lang: string;
  text: string;
  streaming: boolean;
}
export type HighlightResult =
  | { type: "ready"; id: number; block: number; lang: string }
  | {
    type: "projection";
    id: number;
    block: number;
    generation: number;
    start: number;
    tokens: HighlightToken[];
  }
  | (
    & { type: "progress"; id: number; block: number; generation: number }
    & HighlightChunk
  )
  | ({
    type: "done";
    id: number;
    block: number;
    generation: number;
    plain?: boolean;
  } & HighlightChunk)
  | {
    type: "error";
    id: number;
    block: number;
    generation?: number;
    error: string;
  };
export interface HighlightCompletion {
  plain?: boolean;
}
