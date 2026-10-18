// SPDX-License-Identifier: LGPL-3.0-only
import type { QuestionRequest } from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";

type Question = QuestionRequest["questions"][number];

/** One question's draft: picked options plus the user's own answer. */
export interface QuestionDraft {
  picked: string[];
  /** The typed own answer; kept while another option is chosen. */
  own: string;
  /** Whether the own answer is part of the answer. */
  ownChosen: boolean;
}
export interface QuestionFormState {
  /** 0..questions-1 are the questions; `questions.length` is the review step. */
  step: number;
  drafts: QuestionDraft[];
}
/**
 * A pending question request as a form: steps, per-question drafts and the
 * answers they stand for. Answers are always derived from the drafts.
 */
export interface QuestionForm {
  readonly questions: readonly Question[];
  readonly state: Readonly<QuestionFormState>;
  /** The review step's index. */
  readonly review: number;
  /** Go to a step (clamped). */
  goTo(step: number): void;
  /** The next step; from the last question that is the review step. */
  next(): void;
  /** Pick option `option` of question `question`: single choice replaces, multiple toggles. */
  pick(question: number, option: number): void;
  /** Choose the own answer: single choice makes it the answer, multiple toggles it. */
  chooseOwn(question: number): void;
  /** Typing the own answer also chooses it. */
  typeOwn(question: number, text: string): void;
  isPicked(question: number, option: number): boolean;
  isOwnChosen(question: number): boolean;
  answers(): string[][];
  subscribe(listener: () => void): () => void;
}

const empty = (): QuestionDraft => ({ picked: [], own: "", ownChosen: false });

export function answerOf(draft: QuestionDraft): string[] {
  const own = draft.ownChosen ? draft.own.trim() : "";
  return own ? [...draft.picked, own] : [...draft.picked];
}

const kept = new Map<string, QuestionFormState>();
const copy = (state: QuestionFormState): QuestionFormState =>
  JSON.parse(JSON.stringify(state));

/**
 * The form for a request. Its state outlives the view (switching sessions and
 * back keeps what was entered) until `forgetQuestionForm` after the reply.
 */
export function createQuestionForm(
  request: QuestionRequest,
  factory: StateFactory = createState,
): QuestionForm {
  const questions = request.questions;
  const review = questions.length;
  const initial = kept.get(request.id) ??
    { step: 0, drafts: questions.map(empty) };
  const store = factory<QuestionFormState>(copy(initial));
  const remember = () => kept.set(request.id, copy(store.state));
  const edit = (question: number, change: (draft: QuestionDraft) => void) => {
    if (!questions[question]) return;
    store.update((state) => change(state.drafts[question]));
    remember();
  };
  const goTo = (step: number) => {
    store.update((state) => {
      state.step = Math.max(0, Math.min(review, step));
    });
    remember();
  };
  return {
    questions,
    state: store.state,
    review,
    goTo,
    next: () => goTo(store.state.step + 1),
    pick(question, option) {
      const q = questions[question], label = q?.options[option]?.label;
      if (label === undefined) return;
      edit(question, (draft) => {
        if (!q.multiple) {
          draft.picked = [label];
          draft.ownChosen = false;
        } else {
          draft.picked = draft.picked.includes(label)
            ? draft.picked.filter((value) => value !== label)
            : [...draft.picked, label];
        }
      });
    },
    chooseOwn(question) {
      const q = questions[question];
      if (!q?.custom) return;
      edit(question, (draft) => {
        if (!q.multiple) {
          draft.picked = [];
          draft.ownChosen = true;
        } else draft.ownChosen = !draft.ownChosen;
      });
    },
    typeOwn(question, text) {
      const q = questions[question];
      if (!q?.custom) return;
      edit(question, (draft) => {
        draft.own = text;
        draft.ownChosen = true;
        if (!q.multiple) draft.picked = [];
      });
    },
    isPicked: (question, option) =>
      store.state.drafts[question]?.picked.includes(
        questions[question]?.options[option]?.label ?? "\u0000",
      ) ?? false,
    isOwnChosen: (question) => store.state.drafts[question]?.ownChosen ?? false,
    answers: () => store.state.drafts.map(answerOf),
    subscribe: (listener) => store.subscribe(() => listener()),
  };
}
export function forgetQuestionForm(requestID: string): void {
  kept.delete(requestID);
}
