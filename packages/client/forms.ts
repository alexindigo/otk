// SPDX-License-Identifier: LGPL-3.0-only
import type {
  FormAnswer,
  FormField,
  FormRequest,
  FormValue,
  QuestionRequest,
} from "@otk/protocol";
import { createState, type StateFactory } from "./state.ts";
export interface FormDraft {
  value?: FormValue;
  text?: string;
  custom?: string;
  customValue?: string;
  revealed?: boolean;
  touched?: boolean;
  choice?: { picked: string[]; own: string; ownChosen: boolean };
}
export interface FormState {
  drafts: Record<string, FormDraft>;
  review: boolean;
  step: number;
}
export interface FormProjection {
  answer: FormAnswer;
  active: FormField[];
  visible: FormField[];
  hidden: FormField[];
  issues: Record<string, string>;
}
export interface FormController {
  state: FormState;
  edit(key: string, change: (draft: FormDraft) => void): void;
  goTo(step: number, limit: number): void;
  derive(): FormProjection;
  pick(key: string, value: string): void;
  customText(key: string, text: string): void;
  addCustom(key: string): void;
  set(key: string, value?: FormValue): void;
  text(key: string, text: string): void;
  reveal(key: string): void;
  review(value: boolean): void;
  subscribe(listener: () => void): () => void;
}
const kept = new Map<string, FormState>();
const copy = (value: FormState): FormState => JSON.parse(JSON.stringify(value));
export function forgetForm(id: string): void {
  kept.delete(id);
}
function issue(
  field: FormField,
  value: FormValue | undefined,
): string | undefined {
  if (field.type === "external") {
    return value === true
      ? undefined
      : "Confirm that the external step is complete.";
  }
  if (value === undefined) {
    return field.required ? "An answer is required." : undefined;
  }
  if (field.type === "string") {
    if (typeof value !== "string") return "Enter text.";
    if (field.required && !value.length) return "An answer is required.";
    if (field.minLength !== undefined && value.length < field.minLength) {
      return `Use at least ${field.minLength} characters.`;
    }
    if (field.maxLength !== undefined && value.length > field.maxLength) {
      return `Use at most ${field.maxLength} characters.`;
    }
    if (field.pattern !== undefined) {
      try {
        if (
          !new RegExp(field.pattern).test(value)
        ) return "The answer does not match the required pattern.";
      } catch {
        return "This field has an invalid pattern.";
      }
    }
    if (
      field.options && !field.custom &&
      !field.options.some((o) => o.value === value)
    ) return "Choose one of the offered values.";
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return "Enter an email address.";
    }
    if (field.format === "uri" && !URL.canParse(value)) {
      return "Enter a complete URI.";
    }
    if (field.format === "date") {
      const date = new Date(`${value}T00:00:00.000Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
      ) return "Enter a valid date (YYYY-MM-DD).";
    }
    if (field.format === "date-time" && !Number.isFinite(Date.parse(value))) {
      return "Enter a date and time with its time zone.";
    }
  } else if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return "Enter a finite number.";
    }
    if (field.type === "integer" && !Number.isInteger(value)) {
      return "Enter a whole number.";
    }
    if (field.minimum !== undefined && value < field.minimum) {
      return `Use at least ${field.minimum}.`;
    }
    if (field.maximum !== undefined && value > field.maximum) {
      return `Use at most ${field.maximum}.`;
    }
  } else if (field.type === "boolean") {
    if (typeof value !== "boolean") return "Choose on or off.";
  } else if (field.type === "multiselect") {
    if (!Array.isArray(value)) return "Choose values.";
    if (field.required && !value.length) return "Choose at least one value.";
    if (field.minItems !== undefined && value.length < field.minItems) {
      return `Choose at least ${field.minItems} values.`;
    }
    if (field.maxItems !== undefined && value.length > field.maxItems) {
      return `Choose at most ${field.maxItems} values.`;
    }
    if (
      !field.custom &&
      value.some((v) => !field.options.some((o) => o.value === v))
    ) return "Choose only offered values.";
  }
}
/** One derivation owns visibility, validation and the exact reviewed/sent payload. */
export function deriveForm(
  fields: readonly FormField[],
  drafts: Readonly<Record<string, FormDraft>>,
): FormProjection {
  const answer: FormAnswer = Object.create(null),
    active: FormField[] = [],
    visible: FormField[] = [],
    hidden: FormField[] = [],
    issues: Record<string, string> = Object.create(null);
  for (const field of fields) {
    if (
      field.type !== "external" && !field.when?.every((w) => {
        const value = answer[w.key];
        if (value === undefined) return false;
        const hit = Array.isArray(value)
          ? value.includes(String(w.value))
          : value === w.value;
        return w.op === "eq" ? hit : !hit;
      }) && field.when
    ) continue;
    active.push(field);
    const draft = drafts[field.key] ?? {};
    let value = draft.value;
    if (field.type === "number" || field.type === "integer") {
      if (draft.text !== undefined) {
        value = draft.text.trim() ? Number(draft.text) : undefined;
      }
    }
    const error = draft.custom
      ? "Add this custom value or clear it before reviewing."
      : issue(field, value);
    if (error) issues[field.key] = error;
    if (
      value !== undefined &&
      !(typeof value === "number" && !Number.isFinite(value))
    ) answer[field.key] = Array.isArray(value) ? [...value] : value;
    if (
      field.type !== "external" && field.hidden && !draft.revealed && !error
    ) hidden.push(field);
    else visible.push(field);
  }
  return { answer, active, visible, hidden, issues };
}
export function createForm(
  request: FormRequest,
  factory: StateFactory = createState,
): FormController {
  const initial: FormState = kept.get(request.id) ?? {
    review: false,
    step: 0,
    drafts: Object.fromEntries(
      request.fields.map(
        (f) => [f.key, {
          ...(f.type !== "external" && f.default !== undefined
            ? { value: Array.isArray(f.default) ? [...f.default] : f.default }
            : {}),
        }],
      ),
    ),
  };
  const store = factory<FormState>(copy(initial));
  const edit = (key: string, change: (draft: FormDraft) => void) => {
    if (!request.fields.some((f) => f.key === key)) return;
    store.update((s) => {
      const draft = s.drafts[key] ?? (s.drafts[key] = {});
      change(draft);
      draft.touched = true;
    });
    kept.set(request.id, copy(store.state));
  };
  return {
    state: store.state,
    edit,
    goTo: (step: number, limit: number) => {
      store.update((s) => {
        s.step = Math.max(0, Math.min(limit, step));
      });
      kept.set(request.id, copy(store.state));
    },
    derive: () => deriveForm(request.fields, store.state.drafts),
    pick: (key: string, value: string) =>
      edit(key, (d) => {
        const field = request.fields.find((f) => f.key === key)!;
        if (field.type === "multiselect") {
          const values = Array.isArray(d.value) ? d.value : [];
          d.value = values.includes(value)
            ? values.filter((v) => v !== value)
            : [...values, value];
        } else if (field.type === "string") d.value = value;
      }),
    customText: (key: string, text: string) =>
      edit(key, (d) => {
        d.custom = text;
      }),
    addCustom: (key: string) =>
      edit(key, (d) => {
        const field = request.fields.find((f) => f.key === key)!;
        if (field.type !== "multiselect" || !field.custom || !d.custom) return;
        const values = Array.isArray(d.value) ? d.value : [];
        d.value = values.includes(d.custom)
          ? [...values]
          : [...values, d.custom];
        d.custom = "";
      }),
    set: (key: string, value?: FormValue) =>
      edit(key, (d) => {
        d.value = value;
        delete d.text;
      }),
    text: (key: string, text: string) =>
      edit(key, (d) => {
        const f = request.fields.find((f) => f.key === key)!;
        if (f.type === "number" || f.type === "integer") {
          d.text = text;
          delete d.value;
        } else {
          d.value = text;
          if (f.type === "string" && f.options && f.custom) {
            d.customValue = text;
          }
        }
      }),
    reveal: (key: string) =>
      edit(key, (d) => {
        d.revealed = true;
      }),
    review: (value: boolean) => {
      store.update((s) => {
        s.review = value;
      });
      kept.set(request.id, copy(store.state));
    },
    subscribe: (listener: () => void) => store.subscribe(listener),
  };
}
/** Legacy V1 questions enter the same typed field renderer, without changing their wire answers. */
export function questionFields(request: QuestionRequest): FormField[] {
  return request.questions.map((q, i) => ({
    key: `q${i}`,
    title: q.header,
    description: q.text,
    type: q.multiple ? "multiselect" as const : "string" as const,
    custom: q.custom,
    options: q.options.map((o) => ({ ...o, value: o.label })),
  }));
}
