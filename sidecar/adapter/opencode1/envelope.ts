// SPDX-License-Identifier: LGPL-3.0-only
/** Select payload.type without allocating any message/part values. */
export function envelopeType(json: string): string | undefined {
  const whitespace = (offset: number) => {
    while (
      offset < json.length && [9, 10, 13, 32].includes(json.charCodeAt(offset))
    ) offset++;
    return offset;
  };
  const stringEnd = (offset: number) => {
    for (let i = offset + 1; i < json.length; i++) {
      if (json[i] === "\\") i++;
      else if (json[i] === '"') return i + 1;
    }
    return -1;
  };
  const valueEnd = (offset: number): number => {
    if (json[offset] === '"') return stringEnd(offset);
    if (json[offset] !== "{" && json[offset] !== "[") {
      let end = offset;
      while (
        end < json.length &&
        ![9, 10, 13, 32, 44, 93, 125].includes(json.charCodeAt(end))
      ) end++;
      return end > offset ? end : -1;
    }
    const closing = [json[offset] === "{" ? "}" : "]"];
    for (let i = offset + 1; i < json.length; i++) {
      const ch = json[i];
      if (ch === '"') {
        const end = stringEnd(i);
        if (end < 0) return -1;
        i = end - 1;
      } else if (ch === "{" || ch === "[") closing.push(ch === "{" ? "}" : "]");
      else if (ch === "}" || ch === "]") {
        if (closing.pop() !== ch) return -1;
        if (!closing.length) return i + 1;
      }
    }
    return -1;
  };
  const property = (offset: number, name: string): number | undefined => {
    if (json[offset] !== "{") return;
    let i = whitespace(offset + 1), found: number | undefined;
    while (json[i] !== "}") {
      if (json[i] !== '"') return;
      const end = stringEnd(i);
      if (end < 0) return;
      // A matching ASCII key, even fully escaped as \uXXXX, cannot be longer.
      const matches = end - i <= name.length * 6 + 2 &&
        JSON.parse(json.slice(i, end)) === name;
      i = whitespace(end);
      if (json[i] !== ":") return;
      i = whitespace(i + 1);
      if (matches) found = i;
      const next = valueEnd(i);
      if (next < 0) return;
      i = whitespace(next);
      if (json[i] === "}") break;
      if (json[i] !== ",") return;
      i = whitespace(i + 1);
    }
    // Match JSON.parse's last-key-wins semantics; never rely on field order.
    return found;
  };
  try {
    const payload = property(whitespace(0), "payload");
    if (payload === undefined) return;
    const type = property(payload, "type");
    if (type === undefined || json[type] !== '"') return;
    const end = stringEnd(type);
    if (end < 0) return;
    return JSON.parse(json.slice(type, end));
  } catch {
    // If selection fails, leave validation and diagnostics to the full decoder.
    return undefined;
  }
}
