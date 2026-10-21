import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BeatSheet } from '@tes5/workspace';
import { EXPECTED } from '../models/beats/expected';
import { scoreBeats } from '../models/beats/score';

const DOC = readFileSync(join(import.meta.dirname, '../models/beats/screenplay.md'), 'utf8');
const want = EXPECTED.find((e) => e.doc === 'screenplay.md')!;

/** "A Drink for the Mare" read right. */
function right(): BeatSheet {
  const person = (key: string, name: string) => ({ key, name, existing: name, description: '', sex: null, race: null, place: null, spot: null, essential: null, hostile: false, quote: '' });
  return {
    title: 'A Drink for the Mare',
    editorId: 'ADrinkForTheMare',
    summary: '',
    start: { kind: 'game' },
    people: [person('hulda', 'Hulda'), person('sabjorn', 'Sabjorn')],
    places: [
      { key: 'mare', name: 'The Bannered Mare', existing: 'WhiterunBanneredMare', description: '', quote: '' },
      { key: 'meadery', name: 'Honningbrew Meadery', existing: 'HonningbrewMeadery', description: '', quote: '' },
    ],
    items: [{ key: 'cask', name: 'Cask of Honningbrew Mead', kind: 'misc', existing: null, place: 'meadery', carriedBy: null, spot: 'by the stairs', count: 1, text: null, lockedWith: null, quote: '' }],
    groups: [{ key: 'skeevers', what: 'skeever', count: 5, place: 'meadery', spot: null, hidden: false, quote: '' }],
    beats: [
      { id: 'job', does: 'talk', target: 'hulda', after: [], quote: '', journal: null, objective: null, ends: null, effects: {} },
      { id: 'agree', does: 'talk', target: 'sabjorn', after: ['job'], quote: '', journal: null, objective: null, ends: null, effects: {} },
      { id: 'clear', does: 'clear', target: 'skeevers', after: ['agree'], quote: '', journal: null, objective: null, ends: null, effects: {} },
      { id: 'cask', does: 'talk', target: 'sabjorn', after: ['clear'], quote: '', journal: null, objective: null, ends: null, effects: {} },
      { id: 'talked', does: 'talk', target: 'sabjorn', after: ['job'], quote: '', journal: null, objective: null, ends: null, effects: {} },
      { id: 'done', does: 'talk', target: 'hulda', after: ['cask', 'talked'], quote: '', journal: null, objective: null, ends: 'complete', effects: {} },
    ],
    dialogue: [
      { block: 1, when: null, lines: [{ line: 3, beat: 'job' }] },
      { block: 2, when: 'job', lines: [{ line: 4, beat: 'agree' }, { line: 6, beat: 'talked' }] },
      { block: 3, when: 'clear', lines: [{ line: 2, beat: 'cask' }] },
      { block: 4, when: 'cask', lines: [{ line: 2, beat: 'done' }] },
    ],
    lines: [],
  };
}

describe('scoring a reading against the expected one', () => {
  it('gives a right reading full marks', () => {
    const s = scoreBeats(right(), want, DOC);
    expect(s.missing).toEqual([]);
    expect(s).toMatchObject({ people: [2, 2], places: [2, 2], items: [1, 1], beats: [6, 6], extra: 0, order: [5, 5], endings: [1, 1], links: [4, 4] });
  });

  it('counts what a small model typically gets wrong', () => {
    const sheet = right();
    // The clearing and the reward run together; the ending isn't marked; a line linked one off.
    sheet.beats = sheet.beats.filter((b) => b.id !== 'clear');
    sheet.beats.find((b) => b.id === 'cask')!.after = ['agree'];
    sheet.beats.find((b) => b.id === 'done')!.ends = null;
    sheet.dialogue[1]!.lines[0]!.line = 3;
    const s = scoreBeats(sheet, want, DOC);
    expect(s.beats).toEqual([5, 6]);
    expect(s.endings).toEqual([0, 1]);
    expect(s.links).toEqual([3, 4]);
    expect(s.missing).toEqual(['beat 2: clear skeevers', 'ending: done should complete', "link: “You will? Then the cask's yours” should complete beat 1"]);
  });
});
