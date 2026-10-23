import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(import.meta.dirname, '../../src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe('effects', () => {
  // An effect's arrow without braces returns its value, and React calls whatever an effect returns as its cleanup. A
  // DOM call that returns something (scrollIntoView returns a promise in newer Chromium) then crashes the view with
  // "l is not a function" when it re-renders or closes: the AI tab did in 0.37.0.
  it('never return a value (each has a block body)', () => {
    const found = sources(SRC).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => [line, i + 1] as const)
        .filter(([line]) => /use(Layout)?Effect\(\(\) => [^{]/.test(line))
        .map(([, n]) => `${f.slice(SRC.length + 1)}:${n}`),
    );
    expect(found).toEqual([]);
  });
});
