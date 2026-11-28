// SPDX-License-Identifier: LGPL-3.0-only
import { Source } from "./analysis.ts";
import { property, type t } from "./syntax.ts";
import { cssTree, rules, selectorAlternatives } from "./styles.ts";

const tokens = (text: string) =>
  text.split(/\s+/).filter((part) => /^[a-z_][\w-]*$/i.test(part));
function classTokens(source: Source, node: t.JSXOpeningElement): string[] {
  const value = source.value(source.attr(node, "class"));
  if (!value) return [];
  return source.all.filter((n) =>
    n.start! >= value.start! && n.end! <= value.end!
  )
    .flatMap((n) =>
      n.type === "StringLiteral"
        ? tokens(n.value)
        : n.type === "TemplateElement"
        ? tokens(n.value.raw)
        : []
    );
}
function targets(selector: string): string[] {
  return selectorAlternatives(selector).flatMap((branch) => {
    const tree = cssTree.parse(branch, { context: "selector" });
    if (tree.type !== "Selector") return [];
    const nodes = tree.children.toArray();
    const last = nodes.findLastIndex((n) => n.type === "Combinator");
    const result: string[] = [];
    for (const node of nodes.slice(last + 1)) {
      cssTree.walk(node, (n) => {
        if (n.type === "ClassSelector") result.push(n.name);
      });
    }
    // A descendant type selector still reaches the preceding component's internals.
    if (!result.length) {
      for (const node of nodes.slice(0, last)) {
        cssTree.walk(node, (n) => {
          if (n.type === "ClassSelector") result.push(n.name);
        });
      }
    }
    return result;
  });
}

/** Native class emitters plus their imported CSS establish ownership; caller
 * class/triggerClass slots are deliberately not internal classes. */
export function styleBoundaryErrors(files: Map<string, string>): string[] {
  const styles = new Map(
    [...files].filter(([p]) => p.endsWith(".css")).map((
      [p, text],
    ) => [p, rules(text)]),
  );
  const utilities = new Set(
    (styles.get("packages/ui/theme.css") ?? []).flatMap((r) =>
      targets(r.selector)
    ),
  );
  const owners = new Map<string, Set<string>>();
  const slots = new Map<string, Set<string>>();
  const disclosures = new Set<string>();
  for (const [path, text] of files) {
    if (!path.endsWith(".tsx")) continue;
    const source = new Source(text, path);
    const imported = source.all.filter((n): n is t.ImportDeclaration =>
      n.type === "ImportDeclaration" && n.source.value.endsWith(".css")
    )
      .map((n) =>
        new URL(n.source.value, new URL(path, "https://otk.invalid/")).pathname
          .slice(1)
      );
    const ownStyles = (name: string, primary: boolean) => {
      const matched = imported.filter((css) =>
        (styles.get(css) ?? []).some(({ selector }) =>
          targets(selector).includes(name)
        )
      );
      if (matched.length) return matched;
      const associated = path.replace(/\.tsx$/, ".css");
      return primary && imported.includes(associated) ? [associated] : [];
    };
    for (const node of source.all) {
      if (node.type !== "ObjectProperty" || property(node.key) !== "class") {
        continue;
      }
      const object = source.parent.get(node),
        call = object && source.parent.get(object);
      if (
        call?.type !== "CallExpression" ||
        !["selection", "feedbackState"].includes(
          source.imported(call.callee)?.name ?? source.name(call.callee) ?? "",
        )
      ) continue;
      const value = source.value(node.value);
      const text = value?.type === "TemplateLiteral"
        ? value.quasis.map((q) => q.value.raw).join(" ")
        : source.string(value) ?? "";
      for (
        const name of tokens(text).filter((c) =>
          !utilities.has(c) && !/^(?:is|has|uses)-/.test(c)
        )
      ) {
        for (const css of ownStyles(name, true)) {
          const set = owners.get(name) ?? new Set<string>();
          set.add(css);
          owners.set(name, set);
        }
      }
    }
    for (const node of source.all) {
      if (node.type !== "JSXOpeningElement") continue;
      const classes = classTokens(source, node);
      if (source.imported(node.name)) {
        for (const attr of node.attributes) {
          if (
            attr.type !== "JSXAttribute" ||
            !/^(?:class|\w*Class)$/.test(property(attr.name) ?? "")
          ) continue;
          const value = source.value(attr.value),
            text = value?.type === "TemplateLiteral"
              ? value.quasis.map((q) => q.value.raw).join(" ")
              : source.string(value) ?? "";
          for (const name of tokens(text)) {
            for (const css of imported) {
              const set = slots.get(name) ?? new Set<string>();
              set.add(css);
              slots.set(name, set);
            }
          }
        }
      }
      if (
        /\/Disclosure(?:Toggle)?\.tsx$/.test(
          source.imported(node.name)?.module ?? "",
        )
      ) classes.forEach((c) => disclosures.add(c));
      if (
        node.name.type !== "JSXIdentifier" ||
        !/^[a-z]/.test(node.name.name) && source.imported(node.name)
      ) continue;
      for (const [index, name] of classes.entries()) {
        if (/^(?:is|has|uses)-/.test(name)) continue;
        if (utilities.has(name)) continue;
        for (const css of ownStyles(name, index === 0)) {
          const set = owners.get(name) ?? new Set<string>();
          set.add(css);
          owners.set(name, set);
        }
      }
    }
  }
  const errors: string[] = [];
  for (const [name, css] of owners) {
    if (css.size > 1) {
      errors.push(
        `${name}: native internals have multiple style owners: ${
          [...css].join(", ")
        }`,
      );
    }
  }
  // Exported shared style roles (for example VirtualList's measurement samples)
  // are defined at their owner's root, not by the consumer supplying that role.
  const definitions = new Map<string, Set<string>>();
  for (const [path, rs] of styles) {
    for (const { selector } of rs) {
      for (const branch of selectorAlternatives(selector)) {
        const ast = cssTree.parse(branch, { context: "selector" });
        if (
          ast.type !== "Selector" ||
          ast.children.some((n) => n.type === "Combinator")
        ) continue;
        const first = ast.children.first;
        if (
          first?.type !== "ClassSelector" ||
          /^(?:is|has|uses)-/.test(first.name) || utilities.has(first.name)
        ) continue;
        const set = definitions.get(first.name) ?? new Set<string>();
        set.add(path);
        definitions.set(first.name, set);
      }
    }
  }
  for (const [name, css] of definitions) {
    if (!owners.has(name)) {
      owners.set(name, css);
      if (css.size > 1) {
        errors.push(
          `${name}: conflicting style owners: ${[...css].join(", ")}`,
        );
      }
    }
  }
  for (const [name, css] of slots) {
    if (!owners.has(name) && !utilities.has(name)) owners.set(name, css);
  }
  for (const [path, rs] of styles) {
    for (const { selector, declarations } of rs) {
      for (const name of targets(selector)) {
        const own = owners.get(name);
        if (path !== "packages/ui/theme.css" && own && !own.has(path)) {
          errors.push(
            `${path}: ${selector}: targets ${name}, owned by ${
              [...own].join(", ")
            }`,
          );
        }
      }
      if (
        !/^packages\/ui\/components\/Disclosure(?:Toggle)?\.css$/.test(path) &&
        (
          /\.otk-disclosure-[\w-]+/.test(selector) ||
          targets(selector).some((name) => disclosures.has(name)) &&
            [...declarations.keys()].some((key) =>
              /^(?:display|grid-template(?:-.+)?|gap|column-gap|row-gap|padding(?:-.+)?)$/
                .test(key)
            )
        )
      ) {
        errors.push(
          `${path}: ${selector}: Disclosure owns all internal geometry`,
        );
      }
    }
  }
  return [...new Set(errors)];
}

/** Presentation separators must not be manufactured in ports or code. File
 * paths use unspaced slashes and remain data, not breadcrumb presentation. */
export function codeSeparatorErrors(path: string, text: string): string[] {
  const source = new Source(text, path);
  return source.all.flatMap((node) => {
    const bad =
      node.type === "StringLiteral" && /^\s+[\/·]\s+$/.test(node.value) ||
      node.type === "TemplateLiteral" && node.expressions.length > 0 &&
        node.quasis.some((q) => /\s[\/·]\s/.test(q.value.raw)) ||
      node.type === "BinaryExpression" && node.operator === "+" &&
        [node.left, node.right].some((n) =>
          n.type === "StringLiteral" && /^\s+[\/·]\s+$/.test(n.value)
        ) ||
      node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        property(node.callee.property) === "join" &&
        /^\s+[\/·]\s+$/.test(source.string(node.arguments[0]) ?? "");
    return bad && path !== "packages/client/format.ts"
      ? [
        `${path}:${node.loc?.start.line}: use metaList or the shared breadcrumb separator, not a code-built path`,
      ]
      : [];
  });
}
