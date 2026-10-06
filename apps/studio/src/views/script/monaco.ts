/**
 * Monaco set-up for Papyrus: syntax colouring plus completion, hover and
 * signature help backed by the engine's Papyrus language service.
 *
 * Fragment editors only show a function body; they register a prefix/suffix
 * so the language service sees a complete script and offsets map back.
 */
import 'monaco-editor/features/register.all';
import * as monaco from 'monaco-editor/editor';
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker';
import { useStore } from '../../state/store';

export { monaco };

declare global {
  interface Window {
    MonacoEnvironment?: { getWorker(id: string, label: string): Worker };
  }
}

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export interface ModelContext {
  prefix: string;
  suffix: string;
}

const contexts = new Map<string, ModelContext>();

export function setModelContext(model: monaco.editor.ITextModel, ctx: ModelContext | undefined): void {
  if (ctx) contexts.set(model.uri.toString(), ctx);
  else contexts.delete(model.uri.toString());
}

/** The full source the language service should see, and the offset shift. */
export function fullSource(model: monaco.editor.ITextModel): { source: string; shift: number } {
  const ctx = contexts.get(model.uri.toString());
  return ctx ? { source: ctx.prefix + model.getValue() + ctx.suffix, shift: ctx.prefix.length } : { source: model.getValue(), shift: 0 };
}

const KEYWORDS = [
  'scriptname', 'extends', 'import', 'function', 'endfunction', 'event', 'endevent', 'property', 'endproperty', 'auto', 'autoreadonly', 'conditional', 'hidden', 'global', 'native',
  'state', 'endstate', 'if', 'elseif', 'else', 'endif', 'while', 'endwhile', 'return', 'as', 'new', 'length', 'none', 'true', 'false', 'self', 'parent',
];
const TYPES = ['int', 'float', 'bool', 'string', 'var'];

let registered = false;

export function registerPapyrus(): void {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: 'papyrus', extensions: ['.psc'], aliases: ['Papyrus'] });
  monaco.languages.setLanguageConfiguration('papyrus', {
    comments: { lineComment: ';', blockComment: [';/', '/;'] },
    brackets: [
      ['(', ')'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '(', close: ')' },
      { open: '[', close: ']' },
      { open: '"', close: '"', notIn: ['string', 'comment'] },
    ],
    indentationRules: {
      increaseIndentPattern: /^\s*(function|event|state|auto\s+state|if|elseif|else|while|property)\b(?!.*\b(native|auto|autoreadonly)\s*$).*$/i,
      decreaseIndentPattern: /^\s*(endfunction|endevent|endstate|endif|elseif|else|endwhile|endproperty)\b/i,
    },
    wordPattern: /[A-Za-z_][A-Za-z0-9_]*/,
  });
  monaco.languages.setMonarchTokensProvider('papyrus', {
    ignoreCase: true,
    keywords: KEYWORDS,
    typeKeywords: TYPES,
    tokenizer: {
      root: [
        [/;\/.*?\/;/, 'comment'],
        [/;\//, 'comment', '@blockComment'],
        [/;.*$/, 'comment'],
        [/\{/, 'comment.doc', '@docComment'],
        [/"/, 'string', '@string'],
        [/0x[0-9a-f]+/, 'number.hex'],
        [/-?\d+\.\d*|\.\d+/, 'number.float'],
        [/\d+/, 'number'],
        [/[A-Za-z_][\w]*(?=\s*\()/, { cases: { '@keywords': 'keyword', '@typeKeywords': 'type', '@default': 'function' } }],
        [/[A-Za-z_][\w]*/, { cases: { '@keywords': 'keyword', '@typeKeywords': 'type', '@default': 'identifier' } }],
        [/[()[\],.]/, 'delimiter'],
        [/[=!<>+\-*/%&|]+/, 'operator'],
        [/\\\s*$/, 'operator'],
      ],
      blockComment: [
        [/\/;/, 'comment', '@pop'],
        [/./, 'comment'],
      ],
      docComment: [
        [/\}/, 'comment.doc', '@pop'],
        [/./, 'comment.doc'],
      ],
      string: [
        [/\\./, 'string.escape'],
        [/"/, 'string', '@pop'],
        [/[^\\"]+/, 'string'],
      ],
    },
  });
  monaco.editor.defineTheme('tes5-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'c792ea' },
      { token: 'type', foreground: '4fc1ff' },
      { token: 'function', foreground: 'dcdcaa' },
      { token: 'comment.doc', foreground: '6a9955', fontStyle: 'italic' },
      { token: 'number.hex', foreground: 'b5cea8' },
    ],
    colors: { 'editor.background': '#1e1f22', 'editorGutter.background': '#1e1f22' },
  });

  const KIND: Record<string, monaco.languages.CompletionItemKind> = {
    keyword: monaco.languages.CompletionItemKind.Keyword,
    function: monaco.languages.CompletionItemKind.Function,
    event: monaco.languages.CompletionItemKind.Event,
    property: monaco.languages.CompletionItemKind.Property,
    variable: monaco.languages.CompletionItemKind.Variable,
    type: monaco.languages.CompletionItemKind.Class,
    snippet: monaco.languages.CompletionItemKind.Snippet,
    parameter: monaco.languages.CompletionItemKind.Variable,
  };

  monaco.languages.registerCompletionItemProvider('papyrus', {
    triggerCharacters: ['.', ' '],
    async provideCompletionItems(model, position) {
      const client = useStore.getState().client;
      if (!client) return { suggestions: [] };
      const { source, shift } = fullSource(model);
      const items = await client.call('scriptComplete', source, shift + model.getOffsetAt(position));
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return {
        suggestions: items.map((i) => ({
          label: i.label,
          kind: KIND[i.kind] ?? monaco.languages.CompletionItemKind.Text,
          detail: i.detail,
          documentation: i.documentation,
          insertText: i.insertText ?? i.label,
          insertTextRules: i.isSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          sortText: i.sortText,
          range,
        })),
      };
    },
  });

  monaco.languages.registerHoverProvider('papyrus', {
    async provideHover(model, position) {
      const client = useStore.getState().client;
      if (!client) return null;
      const { source, shift } = fullSource(model);
      const h = await client.call('scriptHover', source, shift + model.getOffsetAt(position));
      if (!h) return null;
      const [first, ...rest] = h.contents.split('\n\n');
      return { contents: [{ value: `\`\`\`papyrus\n${first}\n\`\`\`` }, ...(rest.length ? [{ value: rest.join('\n\n') }] : [])] };
    },
  });

  monaco.languages.registerSignatureHelpProvider('papyrus', {
    signatureHelpTriggerCharacters: ['(', ','],
    async provideSignatureHelp(model, position) {
      const client = useStore.getState().client;
      if (!client) return null;
      const { source, shift } = fullSource(model);
      const s = await client.call('scriptSignature', source, shift + model.getOffsetAt(position));
      if (!s) return null;
      return {
        value: { signatures: [{ label: s.label, documentation: s.documentation, parameters: s.parameters.map((p) => ({ label: p.label })) }], activeSignature: 0, activeParameter: s.activeParameter },
        dispose() {},
      };
    },
  });
}

/** Run diagnostics for a model and show them as markers. */
export async function updateDiagnostics(model: monaco.editor.ITextModel): Promise<{ errors: number; warnings: number }> {
  const client = useStore.getState().client;
  if (!client || model.isDisposed()) return { errors: 0, warnings: 0 };
  const { source, shift } = fullSource(model);
  const version = model.getVersionId();
  const diags = await client.call('scriptCheck', source);
  if (model.isDisposed() || model.getVersionId() !== version) return { errors: 0, warnings: 0 };
  const len = model.getValueLength();
  const markers: monaco.editor.IMarkerData[] = [];
  for (const d of diags) {
    const s = d.range.start.offset - shift;
    const e = Math.max(s + 1, d.range.end.offset - shift);
    if (e < 0 || s > len) continue;
    const a = model.getPositionAt(Math.max(0, s));
    const b = model.getPositionAt(Math.min(len, e));
    markers.push({
      severity: d.severity === 'error' ? monaco.MarkerSeverity.Error : d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
      message: d.message,
      startLineNumber: a.lineNumber,
      startColumn: a.column,
      endLineNumber: b.lineNumber,
      endColumn: b.column === a.column && b.lineNumber === a.lineNumber ? b.column + 1 : b.column,
      code: d.code,
    });
  }
  monaco.editor.setModelMarkers(model, 'papyrus', markers);
  return { errors: markers.filter((m) => m.severity === monaco.MarkerSeverity.Error).length, warnings: markers.filter((m) => m.severity === monaco.MarkerSeverity.Warning).length };
}
