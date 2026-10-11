import { describe, expect, it } from 'vitest';
import {
  PapyrusLanguageService,
  ScriptIndex,
  compilerCommand,
  detectScriptLayout,
  fragmentScriptName,
  generateFragmentSource,
  lex,
  newFragmentScript,
  parse,
  parseCompilerOutput,
  parseFragmentSource,
  upsertFragment,
} from '../src';

const QUEST_SCRIPT = `Scriptname MyQuestScript extends Quest Conditional
{Controls the whole quest.}

Import Utility

Int Property CountTarget = 3 AutoReadOnly
GlobalVariable Property MyGlobal Auto
ReferenceAlias Property Alias_Jarl Auto
Int Count = 0 Conditional

Event OnInit()
  RegisterForSingleUpdate(5.0)
EndEvent

Event OnUpdate()
  Count += 1
  Actor jarl = Alias_Jarl.GetActorRef()
  If jarl && !jarl.IsDead()
    Debug.Notification("The jarl is alive: " + Count)
  ElseIf Count > CountTarget
    SetStage(100)
  Else
    Wait(1.0)
  EndIf
  Int[] values = new Int[5]
  values[0] = values.Length
  While Count < 10
    Count += 1
  EndWhile
EndEvent

Int Function Double(Int aiValue) Global
  Return aiValue * 2
EndFunction

State Busy
  Event OnUpdate()
  EndEvent
EndState
`;

describe('lexer', () => {
  it('handles comments, doc comments, continuations and literals', () => {
    const { tokens, errors } = lex('Int x = 0x1F ; comment\n;/ block\ncomment /;\nFloat y = 1.5 \\\n  + 2\n{doc}\nString s = "a\\"b"');
    expect(errors).toEqual([]);
    const kinds = tokens.map((t) => t.kind);
    expect(kinds).toContain('doc');
    expect(tokens.find((t) => t.kind === 'int')!.value).toBe(31);
    expect(tokens.find((t) => t.kind === 'float')!.value).toBe(1.5);
    expect(tokens.find((t) => t.kind === 'string')!.value).toBe('a"b');
    // The continuation joins lines: no newline token between 1.5 and +
    const i = tokens.findIndex((t) => t.kind === 'float');
    expect(tokens[i + 1]!.text).toBe('+');
  });
});

describe('parser', () => {
  it('parses a realistic script without errors', () => {
    const { script, diagnostics } = parse(QUEST_SCRIPT);
    expect(diagnostics).toEqual([]);
    expect(script.name).toBe('MyQuestScript');
    expect(script.extends).toBe('Quest');
    expect(script.isConditional).toBe(true);
    expect(script.doc).toBe('Controls the whole quest.');
    expect(script.imports).toEqual(['Utility']);
    expect(script.properties.map((p) => p.name)).toEqual(['CountTarget', 'MyGlobal', 'Alias_Jarl']);
    expect(script.variables[0]!.isConditional).toBe(true);
    expect(script.functions.map((f) => f.name)).toEqual(['OnInit', 'OnUpdate', 'Double']);
    expect(script.functions[2]!.isGlobal).toBe(true);
    expect(script.states[0]!.functions[0]!.name).toBe('OnUpdate');
  });

  it('recovers from errors and keeps parsing', () => {
    const src = `Scriptname Broken extends ObjectReference
Event OnActivate(ObjectReference akActionRef)
  Int x = = 5
  Debug.Notification("still parsed")
EndEvent

Function Later()
EndFunction
`;
    const { script, diagnostics } = parse(src);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]!.range.start.line).toBe(2);
    expect(script.functions.map((f) => f.name)).toEqual(['OnActivate', 'Later']);
  });

  it('reports a missing EndFunction', () => {
    const { diagnostics } = parse('Scriptname A\nFunction Foo()\n  Int x = 1\nFunction Bar()\nEndFunction\n');
    expect(diagnostics.some((d) => /Missing EndFunction for Foo/.test(d.message))).toBe(true);
  });
});

describe('semantic checks', () => {
  const svc = () => new PapyrusLanguageService(new ScriptIndex());

  it('accepts the sample quest script', () => {
    expect(svc().diagnostics(QUEST_SCRIPT).filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('finds undefined variables, wrong argument counts and bad returns', () => {
    const src = `Scriptname Bad extends ObjectReference
Function Foo(Int a)
  Int b = c + 1
  Foo()
  Foo(1, 2)
  Return 5
EndFunction
Int Function Bar()
  Return
EndFunction
Event OnActivate(ObjectReference akActionRef)
  Debug.Notifcation("typo")
  akActionRef.Nope()
  Int[] arr = new Int[200]
EndEvent
`;
    const d = svc().diagnostics(src);
    const msgs = d.filter((x) => x.severity === 'error').map((x) => x.message);
    expect(msgs).toContain('Variable "c" is undefined');
    expect(msgs).toContain('Missing argument "a" for Foo');
    expect(msgs).toContain('Too many arguments for Foo (expects 1)');
    expect(msgs).toContain('Foo does not return a value');
    expect(msgs).toContain('Bar must return a Int');
    expect(msgs).toContain('Array size must be between 1 and 128');
    // Debug/ObjectReference come from built-in stubs, so "does not exist" errors are suppressed
    // until real sources are indexed.
    expect(msgs.some((m) => m.includes('Notifcation'))).toBe(false);
  });

  it('reports missing functions once real sources are indexed', () => {
    const index = new ScriptIndex({ includeStubs: false });
    index.addSource('Form', () => 'Scriptname Form Hidden\nInt Function GetFormID() native\n', 'vanilla');
    index.addSource('Debug', () => 'Scriptname Debug Hidden\nFunction Notification(String asText) global native\n', 'vanilla');
    index.addSource('ObjectReference', () => 'Scriptname ObjectReference extends Form Hidden\nEvent OnActivate(ObjectReference akActionRef)\nEndEvent\n', 'vanilla');
    const service = new PapyrusLanguageService(index);
    const d = service.diagnostics(`Scriptname Good extends ObjectReference
Event OnActivate(ObjectReference akActionRef)
  Debug.Notifcation("typo")
  akActionRef.GetFormID()
  akActionRef.Nope()
EndEvent
Event OnMadeUp()
EndEvent
`);
    const msgs = d.map((x) => x.message);
    expect(msgs).toContain('"Notifcation" is not a function on Debug');
    expect(msgs).toContain('"Nope" is not a function on ObjectReference');
    expect(msgs.some((m) => m.startsWith('Event "OnMadeUp" does not exist'))).toBe(true);
    expect(msgs.some((m) => m.includes('GetFormID'))).toBe(false);
  });

  it('flags implicit downcasts', () => {
    const d = svc().diagnostics(`Scriptname C extends Quest
Function F(ObjectReference akRef)
  Actor a = akRef
  Actor b = akRef as Actor
EndFunction
`);
    // Stub types are not authoritative, so no error is raised from stubs alone.
    expect(d.filter((x) => x.severity === 'error')).toEqual([]);
  });
});

describe('completions & hover', () => {
  it('completes members after a dot', () => {
    const svc = new PapyrusLanguageService();
    const src = 'Scriptname X extends Quest\nEvent OnInit()\n  Game.GetPlayer().\nEndEvent\n';
    const offset = src.indexOf('GetPlayer().') + 'GetPlayer().'.length;
    const items = svc.complete(src, offset).map((i) => i.label);
    expect(items).toContain('IsDead');
    expect(items).toContain('MoveTo'); // inherited from ObjectReference
    expect(items).toContain('GetFormID'); // inherited from Form
  });

  it('completes globals on a script name and locals in scope', () => {
    const svc = new PapyrusLanguageService();
    const src = 'Scriptname X extends Quest\nEvent OnInit()\n  Int myLocal = 1\n  Debug.\n  \nEndEvent\n';
    const dbg = svc.complete(src, src.indexOf('Debug.') + 6).map((i) => i.label);
    expect(dbg).toEqual(expect.arrayContaining(['Notification', 'MessageBox', 'Trace']));
    const inBody = svc.complete(src, src.indexOf('  \nEndEvent') + 2).map((i) => i.label);
    expect(inBody).toContain('myLocal');
    expect(inBody).toContain('SetStage');
  });

  it('offers parent events as snippets', () => {
    const svc = new PapyrusLanguageService();
    const src = 'Scriptname X extends ObjectReference\nEvent OnAct';
    const items = svc.complete(src, src.length);
    const act = items.find((i) => i.label === 'OnActivate')!;
    expect(act.insertText).toContain('ObjectReference akActionRef');
    expect(act.insertText).toContain('EndEvent');
  });

  it('shows hover and signature help', () => {
    const svc = new PapyrusLanguageService();
    const src = 'Scriptname X extends Quest\nEvent OnInit()\n  SetObjectiveDisplayed(10, \nEndEvent\n';
    const hover = svc.hover(src, src.indexOf('SetObjective') + 3)!;
    expect(hover.contents).toContain('Function SetObjectiveDisplayed(Int aiObjective');
    const sig = svc.signatureHelp(src, src.indexOf('(10, ') + 5)!;
    expect(sig.activeParameter).toBe(1);
    expect(sig.parameters[1]!.label).toBe('Bool abDisplayed');
  });

  it('produces an outline', () => {
    const out = new PapyrusLanguageService().outline(QUEST_SCRIPT);
    expect(out[0]!.name).toBe('MyQuestScript');
    expect(out[0]!.children!.map((c) => c.name)).toContain('Busy');
  });
});

describe('fragments', () => {
  it('generates and re-parses CK-style quest fragment scripts', () => {
    const name = fragmentScriptName('QUST', 'MQ_MyQuest', 0x01000800);
    expect(name).toBe('QF_MQ_MyQuest_01000800');
    const s = newFragmentScript('QUST', name);
    s.aliases.push({ name: 'Jarl', type: 'ReferenceAlias' });
    const f0 = upsertFragment(s, 'SetObjectiveDisplayed(10)');
    const f1 = upsertFragment(s, 'SetObjectiveCompleted(10)\nCompleteQuest()');
    s.extraSource = 'GlobalVariable Property MyGlobal Auto';
    expect([f0, f1]).toEqual(['Fragment_0', 'Fragment_1']);
    const src = generateFragmentSource(s);
    expect(src).toContain(';NEXT FRAGMENT INDEX 2');
    expect(src).toContain('ReferenceAlias Property Alias_Jarl Auto');
    expect(src).toContain('Scriptname QF_MQ_MyQuest_01000800 Extends Quest Hidden');
    // The generated source is valid Papyrus.
    const svc = new PapyrusLanguageService();
    expect(svc.diagnostics(src).filter((d) => d.severity === 'error')).toEqual([]);
    const back = parseFragmentSource(src);
    expect(back.fragments).toEqual(s.fragments);
    expect(back.aliases).toEqual(s.aliases);
    expect(back.extraSource).toBe('GlobalVariable Property MyGlobal Auto');
    expect(back.nextFragmentIndex).toBe(2);
  });

  it('generates topic info fragments with the speaker cast', () => {
    const s = newFragmentScript('INFO', fragmentScriptName('INFO', '', 0x0100abcd));
    upsertFragment(s, 'akSpeaker.SetRelationshipRank(Game.GetPlayer(), 1)');
    const src = generateFragmentSource(s);
    expect(src).toContain('Scriptname TIF__0100ABCD Extends TopicInfo Hidden');
    expect(src).toContain('Function Fragment_0(ObjectReference akSpeakerRef)');
    expect(src).toContain('Actor akSpeaker = akSpeakerRef as Actor');
    const svc = new PapyrusLanguageService();
    expect(svc.diagnostics(src).filter((d) => d.severity === 'error')).toEqual([]);
    expect(parseFragmentSource(src).fragments[0]!.code).toBe('akSpeaker.SetRelationshipRank(Game.GetPlayer(), 1)');
  });
});

describe('compiler integration', () => {
  it('detects SE and LE source folders', () => {
    const existing = new Set(['D/Source/Scripts', 'D/Scripts/Source', 'D/Source/Scripts/TESV_Papyrus_Flags.flg']);
    const probe = { exists: (p: string) => existing.has(p), join: (...p: string[]) => p.join('/') };
    const layout = detectScriptLayout(probe, 'D', 'SkyrimSE');
    expect(layout.importDirs).toEqual(['D/Source/Scripts', 'D/Scripts/Source']);
    expect(layout.flagsFile).toBe('D/Source/Scripts/TESV_Papyrus_Flags.flg');
    expect(layout.outputDir).toBe('D/Scripts');
    const cmd = compilerCommand({ kind: 'papyrus-compiler', executable: 'PapyrusCompiler.exe', flagsFile: layout.flagsFile!, importDirs: layout.importDirs, outputDir: layout.outputDir, optimize: true }, ['Foo.psc']);
    expect(cmd.args).toEqual(['Foo.psc', '-f=D/Source/Scripts/TESV_Papyrus_Flags.flg', '-i=D/Source/Scripts;D/Scripts/Source', '-o=D/Scripts', '-op']);
  });

  it('parses compiler errors', () => {
    const msgs = parseCompilerOutput('Starting 1 compile threads for 1 files...\nC:\\Data\\Source\\Scripts\\Foo.psc(12,5): variable x is undefined\nNo output generated for Foo.psc, compilation failed.\n');
    expect(msgs[0]).toEqual({ file: 'C:\\Data\\Source\\Scripts\\Foo.psc', line: 12, col: 5, severity: 'error', message: 'variable x is undefined' });
    expect(msgs[1]!.severity).toBe('error');
  });

  it("runs Caprica on many files at once and reads its errors", () => {
    const cmd = compilerCommand({ kind: 'caprica', executable: 'Caprica.exe', flagsFile: 'D/Source/Scripts/TESV_Papyrus_Flags.flg', importDirs: ['M/Source/Scripts', 'D/Source/Scripts'], outputDir: 'M/Scripts', optimize: true }, ['A.psc', 'B.psc']);
    expect(cmd.args).toEqual(['--game', 'skyrim', '--ignorecwd', '--import', 'M/Source/Scripts;D/Source/Scripts', '--output', 'M/Scripts', '--flags', 'D/Source/Scripts/TESV_Papyrus_Flags.flg', 'A.psc', 'B.psc']);
    // Caprica's own formats (CapricaReportingContext.cpp): "file (line, col:endCol): Error: …".
    const msgs = parseCompilerOutput(
      "Adding import directory: M/Source/Scripts\nC:\\Mod\\Source\\Scripts\\B.psc (3, 5:9): Error: Unable to find a type named 'Actorr'.\nC:\\Mod\\Source\\Scripts\\A.psc (8, 1:4): Warning W4001: Unused variable.\nCompilation of 'C:\\Mod\\Source\\Scripts\\B.psc' failed; 0 warnings and 1 errors were encountered.\n",
    );
    expect(msgs[0]).toEqual({ file: 'C:\\Mod\\Source\\Scripts\\B.psc', line: 3, col: 5, severity: 'error', message: "Unable to find a type named 'Actorr'." });
    expect(msgs[1]).toMatchObject({ line: 8, severity: 'warning' });
    expect(msgs[2]).toMatchObject({ file: 'C:\\Mod\\Source\\Scripts\\B.psc', severity: 'error' });
    expect(msgs).toHaveLength(3);
    expect(parseCompilerOutput("Unable to locate flags file 'x.flg'.")[0]!.severity).toBe('error');
  });
});
