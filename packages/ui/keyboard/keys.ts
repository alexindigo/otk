// SPDX-License-Identifier: LGPL-3.0-only
// Ported from kosmozoo/client/js/keys.mjs: data targets, canonical combos,
// case-insensitive bare letters, context conflicts, overrides and reset.
export interface KeyEvent {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null;
  preventDefault?(): void;
}
export function comboFromEvent(e: KeyEvent): string {
  return [
    ...(e.ctrlKey ? ["Ctrl"] : []),
    ...(e.altKey ? ["Alt"] : []),
    ...(e.metaKey ? ["Meta"] : []),
    ...(e.shiftKey ? ["Shift"] : []),
    e.key,
  ].join("+");
}
function effective(key: string, mac: boolean): string {
  return key.split("+").map((part) =>
    part === "Mod" ? mac ? "Meta" : "Ctrl" : part
  ).join("+");
}
export function bindingMatches(
  binding: string,
  e: KeyEvent,
  mac = false,
): boolean {
  binding = effective(binding, mac);
  if (binding.length === 1) {
    return !e.ctrlKey && !e.altKey && !e.metaKey &&
      e.key.toLowerCase() === binding.toLowerCase();
  }
  return comboFromEvent(e).toLowerCase() === binding.toLowerCase();
}
function signature(key: string, mac: boolean): string {
  return effective(key, mac).toLowerCase().replace(/^shift\+(.)$/, "$1");
}
export interface KeyBinding {
  id: string;
  command: string;
  key: string;
  args?: Record<string, unknown>;
  ctx?: string;
  desc?: string;
  inPrompt?: boolean;
}
export interface KeyRow extends KeyBinding {
  defaultKey: string;
  overridden: boolean;
}
function dataOnly(value: unknown, seen = new Set<unknown>()): void {
  if (value == null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || seen.has(value)) {
    throw new TypeError("Bindings contain data only");
  }
  const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
  if (
    array
      ? proto !== Array.prototype
      : proto !== Object.prototype && proto !== null
  ) throw new TypeError("Bindings contain data only");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) =>
      typeof key !== "string" || !Object.hasOwn(descriptors[key], "value") ||
      (!descriptors[key].enumerable && !(array && key === "length"))
    )
  ) throw new TypeError("Bindings contain own data properties only");
  if (array && keys.length !== descriptors.length.value + 1) {
    throw new TypeError("Binding arrays must be dense");
  }
  seen.add(value);
  try {
    for (const key of keys) dataOnly(descriptors[key as string].value, seen);
  } finally {
    seen.delete(value);
  }
}
export function textField(target?: EventTarget | null): boolean {
  if (!target || !("closest" in target)) return false;
  return !!(target as Element).closest(
    "input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox]",
  );
}
export interface KeyChange {
  ok?: boolean;
  error?: string;
  conflict?: string;
  value?: Record<string, string>;
}
export interface Keymap {
  bind(binding: KeyBinding, when?: () => boolean): () => void;
  subscribe(listener: () => void): () => void;
  setKeymap(value: Record<string, string>): void;
  overrides(): Record<string, string>;
  findConflict(id: string, combo: string): string | null;
  propose(id: string, combo: string): KeyChange;
  rebind(id: string, combo: string): KeyChange;
  resetKey(id: string): KeyChange;
  resetAll(): void;
  list(): KeyRow[];
  dispatch(event: KeyEvent): boolean;
}
export function makeKeymap(adapter: {
  describe(command: string): string;
  request(binding: KeyBinding): boolean;
}, mac = false): Keymap {
  const actions: (KeyBinding & { defaultKey: string })[] = [];
  const conditions = new Map<string, () => boolean>();
  const listeners = new Set<() => void>();
  let overrides: Record<string, string> = {};
  const changed = () => {
    for (const listener of listeners) listener();
  };
  const km: Keymap = {
    bind(binding: KeyBinding, when?: () => boolean): () => void {
      dataOnly(binding);
      if (
        !binding || typeof binding.id !== "string" || !binding.id ||
        typeof binding.command !== "string" || !binding.command ||
        typeof binding.key !== "string" ||
        actions.some((a) => a.id === binding.id) ||
        Object.keys(binding).some((key) =>
          !["id", "command", "key", "args", "ctx", "desc", "inPrompt"].includes(
            key,
          )
        ) ||
        ["ctx", "desc"].some((key) =>
          binding[key as "ctx"] !== undefined &&
          typeof binding[key as "ctx"] !== "string"
        ) ||
        (binding.args !== undefined &&
          (!binding.args || typeof binding.args !== "object" ||
            Array.isArray(binding.args))) ||
        (binding.inPrompt !== undefined &&
          typeof binding.inPrompt !== "boolean")
      ) throw new TypeError("Invalid or duplicate binding");
      const desc = binding.desc ?? adapter.describe(binding.command);
      if (typeof desc !== "string") {
        throw new TypeError("Descriptions must be strings");
      }
      const copy = {
        ...structuredClone(binding),
        desc,
        defaultKey: binding.key,
        key: overrides[binding.id] ?? binding.key,
      };
      actions.push(copy);
      if (when) conditions.set(binding.id, when);
      changed();
      return () => {
        const at = actions.indexOf(copy);
        if (at < 0) return;
        actions.splice(at, 1);
        conditions.delete(binding.id);
        changed();
      };
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setKeymap(value: Record<string, string>) {
      overrides = { ...value };
      for (const a of actions) a.key = overrides[a.id] ?? a.defaultKey;
      changed();
    },
    overrides() {
      return { ...overrides };
    },
    findConflict(id: string, combo: string): string | null {
      if (!combo) return null;
      const me = actions.find((a) => a.id === id);
      if (!me) return null;
      return actions.find((a) =>
        a.id !== id && a.key &&
        (!a.ctx || !me.ctx || a.ctx === me.ctx) &&
        signature(a.key, mac) === signature(combo, mac)
      )?.id ?? null;
    },
    propose(
      id: string,
      combo: string,
    ): { value?: Record<string, string>; error?: string; conflict?: string } {
      if (!actions.some((a) => a.id === id)) {
        return { error: `Unknown binding: ${id}` };
      }
      const conflict = km.findConflict(id, combo);
      return conflict ? { conflict } : { value: { ...overrides, [id]: combo } };
    },
    rebind(id: string, combo: string) {
      const result = km.propose(id, combo);
      if (!result.value) return result;
      km.setKeymap(result.value);
      return { ok: true };
    },
    resetKey(id: string) {
      const row = actions.find((a) => a.id === id);
      if (!row) return { error: `Unknown binding: ${id}` };
      const conflict = km.findConflict(id, row.defaultKey);
      if (conflict) return { conflict };
      const value = { ...overrides };
      delete value[id];
      km.setKeymap(value);
      return { ok: true };
    },
    resetAll() {
      km.setKeymap({});
    },
    list(): KeyRow[] {
      return actions.map((a) => ({ ...a, overridden: a.key !== a.defaultKey }));
    },
    dispatch(e: KeyEvent): boolean {
      if (e.isComposing || e.repeat || e.defaultPrevented) return false;
      for (const a of actions) {
        if (
          !a.key || !bindingMatches(a.key, e, mac) ||
          (textField(e.target) && !a.inPrompt) ||
          conditions.get(a.id)?.() === false
        ) continue;
        if (adapter.request(a) === false) continue;
        e.preventDefault?.();
        return true;
      }
      return false;
    },
  };
  return km;
}
