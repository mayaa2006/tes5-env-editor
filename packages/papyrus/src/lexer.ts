/**
 * Papyrus lexer. Papyrus is line-oriented and case-insensitive; newlines end
 * statements unless the line ends with a `\` continuation.
 */

export type TokenKind =
  | 'ident'
  | 'keyword'
  | 'int'
  | 'float'
  | 'string'
  | 'op'
  | 'newline'
  | 'doc'
  | 'eof'
  | 'error';

export interface Position {
  /** 0-based line. */
  line: number;
  /** 0-based column (UTF-16 units). */
  col: number;
  /** Absolute offset. */
  offset: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface Token {
  kind: TokenKind;
  /** Original text. */
  text: string;
  /** Lower-cased text for identifiers/keywords (Papyrus is case-insensitive). */
  lower: string;
  range: Range;
  /** Decoded value for literals. */
  value?: string | number;
}

export const KEYWORDS = new Set([
  'scriptname', 'extends', 'import', 'function', 'endfunction', 'event', 'endevent', 'property', 'endproperty', 'state',
  'endstate', 'auto', 'autoreadonly', 'global', 'native', 'hidden', 'conditional', 'if', 'elseif', 'else', 'endif',
  'while', 'endwhile', 'return', 'new', 'as', 'length', 'none', 'true', 'false', 'self', 'parent', 'bool', 'int',
  'float', 'string', 'debugonly', 'betaonly',
]);

/** Keywords as written in the Creation Kit wiki (for completions and formatting). */
export const KEYWORD_CASING: Record<string, string> = {
  scriptname: 'Scriptname', extends: 'Extends', import: 'Import', function: 'Function', endfunction: 'EndFunction',
  event: 'Event', endevent: 'EndEvent', property: 'Property', endproperty: 'EndProperty', state: 'State',
  endstate: 'EndState', auto: 'Auto', autoreadonly: 'AutoReadOnly', global: 'Global', native: 'Native', hidden: 'Hidden',
  conditional: 'Conditional', if: 'If', elseif: 'ElseIf', else: 'Else', endif: 'EndIf', while: 'While',
  endwhile: 'EndWhile', return: 'Return', new: 'New', as: 'As', length: 'Length', none: 'None', true: 'True',
  false: 'False', self: 'Self', parent: 'Parent', bool: 'Bool', int: 'Int', float: 'Float', string: 'String',
  debugonly: 'DebugOnly', betaonly: 'BetaOnly',
};

const OPERATORS = ['+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '&&', '||', '+', '-', '*', '/', '%', '=', '<', '>', '!', '(', ')', '[', ']', ',', '.'];

export interface LexResult {
  tokens: Token[];
  errors: { message: string; range: Range }[];
  /** Comment ranges (for folding / highlighting). */
  comments: Range[];
}

export function lex(src: string): LexResult {
  const tokens: Token[] = [];
  const errors: LexResult['errors'] = [];
  const comments: Range[] = [];
  let i = 0;
  let line = 0;
  let col = 0;

  const pos = (): Position => ({ line, col, offset: i });
  const advance = (n = 1) => {
    for (let k = 0; k < n; k++) {
      if (src[i] === '\n') {
        line++;
        col = 0;
      } else col++;
      i++;
    }
  };
  const push = (kind: TokenKind, start: Position, value?: string | number) => {
    const text = src.slice(start.offset, i);
    tokens.push({ kind, text, lower: text.toLowerCase(), range: { start, end: pos() }, value });
  };
  const lastSignificant = () => {
    for (let k = tokens.length - 1; k >= 0; k--) if (tokens[k]!.kind !== 'doc') return tokens[k];
    return undefined;
  };

  while (i < src.length) {
    const c = src[i]!;
    // whitespace
    if (c === ' ' || c === '\t' || c === '\r') {
      advance();
      continue;
    }
    // newline
    if (c === '\n') {
      const start = pos();
      advance();
      const prev = tokens[tokens.length - 1];
      if (prev && prev.kind !== 'newline') push('newline', start);
      continue;
    }
    // line continuation
    if (c === '\\') {
      let j = i + 1;
      while (j < src.length && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r')) j++;
      if (src[j] === ';' && src[j + 1] !== '/') {
        while (j < src.length && src[j] !== '\n') j++;
      }
      if (j >= src.length || src[j] === '\n') {
        advance(j - i + (j < src.length ? 1 : 0));
        continue;
      }
      const start = pos();
      advance();
      errors.push({ message: 'Unexpected "\\"', range: { start, end: pos() } });
      continue;
    }
    // comments
    if (c === ';') {
      const start = pos();
      if (src[i + 1] === '/') {
        const end = src.indexOf('/;', i + 2);
        if (end < 0) {
          advance(src.length - i);
          errors.push({ message: 'Unterminated block comment ;/ ... /;', range: { start, end: pos() } });
        } else advance(end + 2 - i);
      } else {
        while (i < src.length && src[i] !== '\n') advance();
      }
      comments.push({ start, end: pos() });
      continue;
    }
    // documentation comment
    if (c === '{') {
      const start = pos();
      const end = src.indexOf('}', i + 1);
      if (end < 0) {
        advance(src.length - i);
        errors.push({ message: 'Unterminated documentation comment { ... }', range: { start, end: pos() } });
        continue;
      }
      advance(end + 1 - i);
      push('doc', start, src.slice(start.offset + 1, end).trim());
      comments.push({ start, end: pos() });
      continue;
    }
    // strings
    if (c === '"') {
      const start = pos();
      advance();
      let value = '';
      let closed = false;
      while (i < src.length && src[i] !== '\n') {
        const ch = src[i]!;
        if (ch === '"') {
          advance();
          closed = true;
          break;
        }
        if (ch === '\\' && i + 1 < src.length) {
          const e = src[i + 1]!;
          value += e === 'n' ? '\n' : e === 't' ? '\t' : e === '\\' ? '\\' : e === '"' ? '"' : e;
          advance(2);
          continue;
        }
        value += ch;
        advance();
      }
      if (!closed) errors.push({ message: 'Unterminated string literal', range: { start, end: pos() } });
      push('string', start, value);
      continue;
    }
    // numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = pos();
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        advance(2);
        while (/[0-9a-fA-F]/.test(src[i] ?? '')) advance();
        push('int', start, parseInt(src.slice(start.offset + 2, i), 16) | 0);
        continue;
      }
      while (/[0-9]/.test(src[i] ?? '')) advance();
      let isFloat = false;
      if (src[i] === '.' && /[0-9]/.test(src[i + 1] ?? '')) {
        isFloat = true;
        advance();
        while (/[0-9]/.test(src[i] ?? '')) advance();
      }
      if ((src[i] === 'e' || src[i] === 'E') && /[-+0-9]/.test(src[i + 1] ?? '')) {
        isFloat = true;
        advance();
        if (src[i] === '-' || src[i] === '+') advance();
        while (/[0-9]/.test(src[i] ?? '')) advance();
      }
      const text = src.slice(start.offset, i);
      push(isFloat ? 'float' : 'int', start, isFloat ? parseFloat(text) : parseInt(text, 10));
      continue;
    }
    // identifiers / keywords (Papyrus allows ':' in namespaced names for FO4; Skyrim does not)
    if (/[A-Za-z_]/.test(c)) {
      const start = pos();
      while (/[A-Za-z0-9_]/.test(src[i] ?? '')) advance();
      const text = src.slice(start.offset, i);
      const lower = text.toLowerCase();
      // "length" is only a keyword after "." — treat it as an identifier elsewhere.
      const prev = lastSignificant();
      const isKw = KEYWORDS.has(lower) && !(lower === 'length' && !(prev && prev.text === '.'));
      push(isKw ? 'keyword' : 'ident', start);
      continue;
    }
    // operators
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      const start = pos();
      advance(op.length);
      push('op', start);
      continue;
    }
    const start = pos();
    advance();
    errors.push({ message: `Unexpected character "${c}"`, range: { start, end: pos() } });
    push('error', start);
  }
  const end = pos();
  if (tokens.length && tokens[tokens.length - 1]!.kind !== 'newline') tokens.push({ kind: 'newline', text: '', lower: '', range: { start: end, end } });
  tokens.push({ kind: 'eof', text: '', lower: '', range: { start: end, end } });
  return { tokens, errors, comments };
}
