import { describe, expect, it } from 'vitest';
import { linesByStage, readAvailability, readSetsStage, readWhen, stageLabel, writeAvailability, writeSetsStage, writeWhen, type Item } from '../../src/views/quest/stageConditions';
import { conditionFunctionByName, newCondition, type FormKey } from '@tes5/esp';

const Q = '000800:Demo.esp' as FormKey;
const OTHER = '000900:Demo.esp' as FormKey;
const gold: Item = { data: { ...newCondition(conditionFunctionByName('GetGold')!.index), op: '>=', value: 100, runOn: 1 } };

describe('when a line can be said', () => {
  it('is always when there are no rules, and other conditions are left alone', () => {
    expect(readWhen([], Q)).toEqual({ when: { kind: 'always' }, others: 0 });
    expect(readWhen([gold], Q)).toEqual({ when: { kind: 'always' }, others: 1 });
  });

  it('does not count the speaker as an "other condition"', () => {
    const speaker: Item = { data: { ...newCondition(conditionFunctionByName('GetIsID')!.index), param1: OTHER } };
    expect(readWhen([speaker], Q)).toEqual({ when: { kind: 'always' }, others: 0 });
    expect(readWhen([speaker, gold], Q).others).toBe(1);
  });

  it('writes each choice and reads it back', () => {
    for (const when of [{ kind: 'at', stage: 20 }, { kind: 'from', stage: 20 }, { kind: 'before', stage: 30 }, { kind: 'thisDone' }, { kind: 'otherDone', quest: OTHER }] as const) {
      const items = writeWhen([gold], Q, when);
      expect(items).toHaveLength(2);
      expect(items[0]).toBe(gold);
      expect(readWhen(items, Q)).toEqual({ when, others: 1 });
    }
  });

  it('changing the rule replaces the old one, and "always" removes it', () => {
    const at = writeWhen([gold], Q, { kind: 'at', stage: 10 });
    const from = writeWhen(at, Q, { kind: 'from', stage: 20 });
    expect(from).toHaveLength(2);
    expect(readWhen(from, Q).when).toEqual({ kind: 'from', stage: 20 });
    expect(writeWhen(from, Q, { kind: 'always' })).toEqual([gold]);
  });

  it('understands conditions written other ways (GetStage >= N, stage not done)', () => {
    const ge: Item = { data: { ...newCondition(conditionFunctionByName('GetStage')!.index), param1: Q, op: '>=', value: 15 } };
    expect(readWhen([ge], Q).when).toEqual({ kind: 'from', stage: 15 });
    const notDone: Item = { data: { ...newCondition(conditionFunctionByName('GetStageDone')!.index), param1: Q, param2: 40, op: '==', value: 0 } };
    expect(readWhen([notDone], Q).when).toEqual({ kind: 'before', stage: 40 });
  });

  it('leaves several stage rules to the full list and does not touch them', () => {
    const items = [...writeWhen([], Q, { kind: 'at', stage: 10 }), ...writeWhen([], Q, { kind: 'thisDone' })];
    expect(readWhen(items, Q).when).toEqual({ kind: 'custom' });
    expect(writeWhen(items, Q, { kind: 'custom' })).toBe(items);
  });

  it('keeps another quest’s stage rules out of "this quest"', () => {
    const items = writeWhen([], OTHER, { kind: 'at', stage: 10 });
    expect(readWhen(items, Q)).toEqual({ when: { kind: 'always' }, others: 1 });
  });
});

describe('moves the quest to a stage', () => {
  it('reads and writes the line, keeping the rest of the script', () => {
    expect(readSetsStage('')).toBeNull();
    expect(readSetsStage('Game.GetPlayer().AddItem(Gold, 5)')).toBeNull();
    const code = writeSetsStage('Game.GetPlayer().AddItem(Gold, 5)', 30);
    expect(code).toBe('GetOwningQuest().SetStage(30)\nGame.GetPlayer().AddItem(Gold, 5)');
    expect(readSetsStage(code)).toBe(30);
    expect(writeSetsStage(code, 40)).toBe('GetOwningQuest().SetStage(40)\nGame.GetPlayer().AddItem(Gold, 5)');
    expect(writeSetsStage(code, null)).toBe('Game.GetPlayer().AddItem(Gold, 5)');
    expect(writeSetsStage('GetOwningQuest().SetStage(10)', null)).toBe('');
  });
});

describe('stage labels', () => {
  it('shows the journal text, trimmed', () => {
    expect(stageLabel(20, 'Find the ring')).toBe('20 – Find the ring');
    expect(stageLabel(0, '')).toBe('0');
    expect(stageLabel(5, 'x'.repeat(80))).toHaveLength(4 + 48);
  });
});

describe('quest-wide dialogue availability', () => {
  it('is open by default and other conditions are left alone', () => {
    expect(readAvailability([], Q)).toEqual({ availability: { from: null, stopAtDone: false }, others: 0 });
    expect(readAvailability([gold], Q)).toEqual({ availability: { from: null, stopAtDone: false }, others: 1 });
  });

  it('writes both settings and reads them back', () => {
    const items = writeAvailability([gold], Q, { from: 10, stopAtDone: true });
    expect(items).toHaveLength(3);
    expect(items[0]).toBe(gold);
    expect(readAvailability(items, Q)).toEqual({ availability: { from: 10, stopAtDone: true }, others: 1 });
  });

  it('changing one setting keeps the other, and clearing both removes the conditions', () => {
    const both = writeAvailability([], Q, { from: 10, stopAtDone: true });
    const later = writeAvailability(both, Q, { from: 20, stopAtDone: true });
    expect(later).toHaveLength(2);
    expect(readAvailability(later, Q).availability).toEqual({ from: 20, stopAtDone: true });
    expect(writeAvailability(later, Q, { from: null, stopAtDone: false })).toEqual([]);
  });

  it('does not touch another quest’s conditions', () => {
    const theirs = writeAvailability([], OTHER, { from: 5, stopAtDone: true });
    expect(readAvailability(theirs, Q)).toEqual({ availability: { from: null, stopAtDone: false }, others: 2 });
    expect(writeAvailability(theirs, Q, { from: null, stopAtDone: false })).toEqual(theirs);
  });
});

describe('lines by stage', () => {
  it('groups responses under the stages they need, start from, end before or set', () => {
    const k = (n: number) => `00000${n}:Demo.esp` as FormKey;
    const m = linesByStage([
      { formKey: k(1), needsStage: 10, fromStage: null, beforeStage: null, setsStage: 20 },
      { formKey: k(2), needsStage: null, fromStage: 10, beforeStage: 30, setsStage: null },
      { formKey: k(3), needsStage: null, fromStage: null, beforeStage: null, setsStage: null },
    ]);
    expect(m.get(10)).toEqual([{ info: k(1), relation: 'only' }, { info: k(2), relation: 'from' }]);
    expect(m.get(20)).toEqual([{ info: k(1), relation: 'sets' }]);
    expect(m.get(30)).toEqual([{ info: k(2), relation: 'until' }]);
    expect(m.size).toBe(3);
  });
});
