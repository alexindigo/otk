// SPDX-License-Identifier: LGPL-3.0-only
import type { createOnigurumaEngine } from "shiki/engine/oniguruma";
type Engine = Awaited<ReturnType<typeof createOnigurumaEngine>>;
type Scanner = ReturnType<Engine["createScanner"]>;
type Match = ReturnType<Scanner["findNextMatchSync"]>;
export function sharedNativeScanners(engine: Engine): Engine {
  const compiled = new Map<string, { scanner: Scanner; users: number }>();
  const acquire = (patterns: string[]) => {
    const key = JSON.stringify(patterns);
    let entry = compiled.get(key);
    if (!entry) {
      entry = { scanner: engine.createScanner(patterns), users: 0 };
      compiled.set(key, entry);
    }
    entry.users++;
    let released = false;
    return {
      scanner: entry.scanner,
      release() {
        if (released) return;
        released = true;
        if (--entry!.users === 0) {
          compiled.delete(key);
          entry!.scanner.dispose?.();
        }
      },
    };
  };
  return {
    createString: engine.createString,
    createScanner(values) {
      const patterns = values.map((value) =>
        typeof value === "string" ? value : value.source
      );
      const runs: { ordinals: number[]; lease: ReturnType<typeof acquire> }[] =
        [];
      const add = (start: number, end: number, unique = true) => {
        if (end > start) {
          const sources: string[] = [], ordinals: number[] = [];
          const seen = new Set<string>();
          for (let i = start; i < end; i++) {
            if (unique && seen.has(patterns[i])) continue;
            seen.add(patterns[i]);
            sources.push(patterns[i]);
            ordinals.push(i);
          }
          runs.push({
            ordinals,
            lease: acquire(sources),
          });
        }
      };
      try {
        if (patterns.some((pattern) => pattern.includes("\\K"))) {
          add(0, patterns.length, false);
        } else {
          let start = 0;
          for (let i = 0; i < patterns.length; i++) {
            const pattern = patterns[i];
            if (
              pattern.includes("\\A") || pattern.includes("\\G") ||
              pattern.includes("\uffff")
            ) {
              add(start, i);
              add(i, i + 1);
              start = i + 1;
            }
          }
          add(start, patterns.length);
        }
      } catch (error) {
        for (const run of runs) run.lease.release();
        throw error;
      }
      let disposed = false;
      return {
        findNextMatchSync(source, position, options) {
          if (disposed) throw new Error("Native scanner disposed");
          const content = typeof source === "string" ? source : source.content;
          let boundary: number | undefined;
          if (
            Number.isInteger(position) && position >= 0 &&
            position <= content.length
          ) {
            boundary = position;
            // The native UTF16→UTF8 map assigns both halves of a pair to the
            // scalar's first byte. A later run cannot begin before that byte.
            const low = content.charCodeAt(position),
              high = content.charCodeAt(position - 1);
            if (
              low >= 0xdc00 && low <= 0xdfff && high >= 0xd800 && high <= 0xdbff
            ) boundary--;
          }
          let best: Match = null;
          for (const run of runs) {
            const result = run.lease.scanner.findNextMatchSync(
              source,
              position,
              options,
            );
            if (!result) continue;
            if (
              !best ||
              result.captureIndices[0].start < best.captureIndices[0].start
            ) {
              best = { ...result, index: run.ordinals[result.index] };
            }
            // Runs and deduplicated sources retain their first original ordinal.
            // Once at the search lower bound, neither an earlier start nor tie
            // winner can remain in the later runs.
            if (best?.captureIndices[0].start === boundary) break;
          }
          return best;
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          for (const run of runs) run.lease.release();
        },
      };
    },
  };
}
