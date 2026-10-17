import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPENAI_PRESETS } from '@tes5/workspace';

describe("the page's content security policy", () => {
  it('lets the browser demo reach every free online service offered in the AI settings', () => {
    const html = readFileSync(join(__dirname, '../../index.html'), 'utf8');
    const connect = /connect-src ([^;]+);/.exec(html)![1]!.split(/\s+/);
    for (const p of OPENAI_PRESETS) {
      const u = new URL(p.url);
      const allowed = u.hostname === 'localhost' ? connect.includes('http://localhost:*') : connect.includes(`${u.protocol}//${u.host}`);
      expect(allowed, `${p.label} (${u.host}) must be in connect-src`).toBe(true);
    }
  });
});
