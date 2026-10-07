/**
 * A small, forgiving XML reader and writer for the tool files mods ship
 * (BodySlide slider sets, presets and groups). It runs in the worker and in
 * Node, where there's no DOMParser. Handles elements, attributes, text,
 * comments, CDATA, processing instructions and the common entities.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Text directly inside the element (trimmed). */
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Bytes (UTF-8, with or without BOM; UTF-16 with BOM) → text. */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  return new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '');
}

/** Parse a document; returns its root element. Throws on input with no element at all. */
export function parseXml(src: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  const texts: string[][] = [[]];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      texts[texts.length - 1]!.push(src.slice(i));
      break;
    }
    if (lt > i) texts[texts.length - 1]!.push(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      // Keep CDATA literal: mark it so entity decoding leaves it alone.
      texts[texts.length - 1]!.push(`\u0000${src.slice(lt + 9, end < 0 ? n : end)}`);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      const end = src.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const gt = findTagEnd(src, lt + 1);
    const body = src.slice(lt + 1, gt);
    i = gt + 1;
    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      // Close up to the matching element (tolerates unclosed children).
      let k = stack.length - 1;
      while (k > 0 && stack[k]!.name !== name) k--;
      if (k === 0) continue;
      while (stack.length > k) closeTop(stack, texts);
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const m = /^\s*([^\s/>]+)/.exec(inner);
    if (!m) continue;
    const el: XmlElement = { name: m[1]!, attrs: parseAttrs(inner.slice(m[0].length)), children: [], text: '' };
    stack[stack.length - 1]!.children.push(el);
    if (!selfClosing) {
      stack.push(el);
      texts.push([]);
    }
  }
  while (stack.length > 1) closeTop(stack, texts);
  const top = root.children[0];
  if (!top) throw new Error('Not an XML document');
  return top;
}

function closeTop(stack: XmlElement[], texts: string[][]): void {
  const el = stack.pop()!;
  const parts = texts.pop()!;
  el.text = parts
    .map((t) => (t.startsWith('\u0000') ? t.slice(1) : decodeEntities(t)))
    .join('')
    .trim();
}

function findTagEnd(src: string, from: number): number {
  let q: string | undefined;
  for (let i = from; i < src.length; i++) {
    const c = src[i]!;
    if (q) {
      if (c === q) q = undefined;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return i;
  }
  return src.length;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"']+))/g;
  for (let m = re.exec(s); m; m = re.exec(s)) out[m[1]!] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  return out;
}

/** Child elements with this name (case-insensitive, as BodySlide reads them). */
export function xmlChildren(el: XmlElement, name: string): XmlElement[] {
  const l = name.toLowerCase();
  return el.children.filter((c) => c.name.toLowerCase() === l);
}

export function xmlChild(el: XmlElement, name: string): XmlElement | undefined {
  return xmlChildren(el, name)[0];
}

/** An attribute, looked up case-insensitively. */
export function xmlAttr(el: XmlElement, name: string): string | undefined {
  if (name in el.attrs) return el.attrs[name];
  const l = name.toLowerCase();
  for (const [k, v] of Object.entries(el.attrs)) if (k.toLowerCase() === l) return v;
  return undefined;
}
