// SPDX-License-Identifier: LGPL-3.0-only
/** Pending input belongs to a real session or to a loaded location, never a fake session. */
export type FormOwner = { kind: "session"; sessionID: string } | {
  kind: "location";
  directory: string;
};
export type FormValue = string | number | boolean | string[];
export type FormAnswer = Record<string, FormValue>;
export interface FormOption {
  value: string;
  label: string;
  description?: string;
}
export interface FormCondition {
  key: string;
  op: "eq" | "neq";
  value: string | number | boolean;
}
interface FormFieldBase {
  key: string;
  title?: string;
  description?: string;
  required?: boolean;
  hidden?: boolean;
  when?: FormCondition[];
}
export type FormField =
  | (FormFieldBase & {
    type: "string";
    format?: "email" | "uri" | "date" | "date-time";
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    placeholder?: string;
    default?: string;
    options?: FormOption[];
    custom?: boolean;
  })
  | (FormFieldBase & {
    type: "number" | "integer";
    minimum?: number;
    maximum?: number;
    default?: number;
  })
  | (FormFieldBase & { type: "boolean"; default?: boolean })
  | (FormFieldBase & {
    type: "multiselect";
    options: FormOption[];
    minItems?: number;
    maxItems?: number;
    custom?: boolean;
    default?: string[];
  })
  | {
    key: string;
    type: "external";
    url: string;
    title?: string;
    description?: string;
  };
export interface FormRequest {
  id: string;
  owner: FormOwner;
  directory: string;
  title: string;
  fields: FormField[];
}
export interface FormsRpcMethods {
  "form.list": {
    params: { sessionID?: string; directory?: string };
    result: FormRequest[];
  };
  "form.reply": {
    params: { requestID: string; answer: FormAnswer };
    result: null;
  };
  "form.cancel": {
    params: { requestID: string; message?: string };
    result: null;
  };
}
/** Wire values remain typed; no answer coercion is performed at transport boundaries. */
export function formAnswer(value: unknown): FormAnswer {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected keyed form answers");
  }
  const result: FormAnswer = Object.create(null);
  for (const [key, v] of Object.entries(value)) {
    if (
      !(typeof v === "string" || typeof v === "boolean" ||
        typeof v === "number" && Number.isFinite(v) ||
        Array.isArray(v) && v.every((x) => typeof x === "string"))
    ) throw new TypeError("Invalid form answer value");
    result[key] = v;
  }
  return result;
}
