/** A Papyrus code editor (Monaco) with live diagnostics from the engine. */
import { useEffect, useRef, useState } from 'react';
import { monaco, registerPapyrus, setModelContext, updateDiagnostics, type ModelContext } from './monaco';

let modelSeq = 0;

export function CodeEditor({
  value,
  onChange,
  onSave,
  context,
  height,
  readOnly,
  onDiagnostics,
  revealLine,
}: {
  value: string;
  onChange?: (v: string) => void;
  /** Ctrl+S inside the editor. */
  onSave?: (v: string) => void;
  /** For fragments: code shown is the body of a larger script. */
  context?: ModelContext;
  height?: number | string;
  readOnly?: boolean;
  onDiagnostics?: (d: { errors: number; warnings: number }) => void;
  revealLine?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const cbs = useRef({ onChange, onSave, onDiagnostics });
  cbs.current = { onChange, onSave, onDiagnostics };
  const [, force] = useState(0);

  useEffect(() => {
    registerPapyrus();
    const model = monaco.editor.createModel(value, 'papyrus', monaco.Uri.parse(`inmemory://papyrus/${++modelSeq}.psc`));
    setModelContext(model, context);
    const ed = monaco.editor.create(el.current!, {
      model,
      theme: 'tes5-dark',
      automaticLayout: true,
      minimap: { enabled: height === undefined },
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
      tabSize: 4,
      insertSpaces: false,
      scrollBeyondLastLine: false,
      readOnly,
      renderWhitespace: 'selection',
      fixedOverflowWidgets: true,
      wordBasedSuggestions: 'off',
      quickSuggestions: { other: true, comments: false, strings: false },
    });
    editor.current = ed;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void updateDiagnostics(model).then((d) => cbs.current.onDiagnostics?.(d)), 350);
    };
    check();
    const sub = model.onDidChangeContent(() => {
      cbs.current.onChange?.(model.getValue());
      check();
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => cbs.current.onSave?.(model.getValue()));
    force((n) => n + 1);
    return () => {
      clearTimeout(timer);
      sub.dispose();
      setModelContext(model, undefined);
      ed.dispose();
      model.dispose();
      editor.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External value changes (e.g. loading another script) replace the text.
  useEffect(() => {
    const ed = editor.current;
    const model = ed?.getModel();
    if (model && model.getValue() !== value) {
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    }
  }, [value]);

  useEffect(() => {
    const model = editor.current?.getModel();
    if (model) setModelContext(model, context);
  }, [context?.prefix, context?.suffix]);

  useEffect(() => {
    if (revealLine && editor.current) {
      editor.current.revealLineInCenter(revealLine);
      editor.current.setPosition({ lineNumber: revealLine, column: 1 });
      editor.current.focus();
    }
  }, [revealLine]);

  return <div ref={el} className="code-frame" style={{ height: height ?? '100%', minHeight: 80 }} data-testid="code-editor" />;
}
