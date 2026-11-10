// SPDX-License-Identifier: LGPL-3.0-only
import type { QuestionRequest } from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
import { createForm, forgetForm, questionFields } from "./forms.ts";

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
  const form = createForm({
    id: request.id,
    owner: { kind: "session", sessionID: request.sessionID },
    directory: "",
    title: "Questions",
    fields: questionFields(request),
  }, factory);
  const draft = (index: number): QuestionDraft =>
    form.state.drafts[`q${index}`]?.choice ?? empty();
  const state: Readonly<QuestionFormState> = {
    get step() {
      return form.state.step;
    },
    get drafts() {
      return questions.map((_, index) => draft(index));
    },
  };
  const edit = (question: number, change: (draft: QuestionDraft) => void) => {
    if (!questions[question]) return;
    form.edit(`q${question}`, (field) => {
      const choice = field.choice ?? (field.choice = empty());
      change(choice);
      const answer = answerOf(choice);
      field.value = questions[question].multiple ? answer : answer[0];
    });
  };
  const goTo = (step: number) => {
    form.goTo(step, review);
  };
  return {
    questions,
    state,
    review,
    goTo,
    next: () => goTo(form.state.step + 1),
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
      draft(question).picked.includes(
        questions[question]?.options[option]?.label ?? "\u0000",
      ) ?? false,
    isOwnChosen: (question) => draft(question).ownChosen,
    answers: () =>
      questions.map((_, index) => {
        const value = form.derive().answer[`q${index}`];
        return Array.isArray(value)
          ? value
          : typeof value === "string"
          ? [value]
          : [];
      }),
    subscribe: (listener) => form.subscribe(listener),
  };
}
export function forgetQuestionForm(requestID: string): void {
  forgetForm(requestID);
}
