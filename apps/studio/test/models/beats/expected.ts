/**
 * What a correct reading of each test document looks like: who and what it involves, and its beats in order. Used to
 * score a reading beat by beat (score.ts), instead of judging it by whatever a build happens to show.
 *
 * A beat lists the readings that count as right ("finds the cart" may be read as arriving there or as reading the
 * note beside it); `after` holds the beats (by index) it must come after; `optional` beats aren't missed if left out.
 * `links` are written lines (by their first words) that complete a beat.
 */
import type { BeatAction } from '@tes5/workspace';

export interface ExpectedBeat {
  as: { does: BeatAction; target: string | null }[];
  after: number[];
  ends?: 'complete' | 'fail';
  optional?: boolean;
}

export interface ExpectedQuest {
  doc: string;
  /** For a questline: which quest (0-based). */
  part?: number;
  people: string[];
  places: string[];
  items: string[];
  beats: ExpectedBeat[];
  links?: { line: string; beat: number }[];
}

const one = (does: BeatAction, target: string | null) => [{ does, target }];

export const EXPECTED: ExpectedQuest[] = [
  {
    doc: 'questline-cartographer.md',
    part: 0,
    people: ['Hesta Coldwater', 'Lucan Valerius'],
    places: ['Sleeping Giant Inn', 'Embershard Mine'],
    items: ['notice', 'Torn Map Page'],
    beats: [
      { as: one('talk', 'Hesta'), after: [] },
      { as: one('pickup', 'Torn Map Page'), after: [0] },
      { as: one('talk', 'Hesta'), after: [1], ends: 'complete' },
    ],
    links: [
      { line: 'The case will be ruined', beat: 0 },
      { line: 'Ha. Fine. 250', beat: 0 },
      { line: 'Three pages. All three', beat: 0 },
      { line: 'Here, as agreed.', beat: 2 },
    ],
  },
  {
    doc: 'questline-cartographer.md',
    part: 1,
    people: ['Hesta Coldwater', 'Rulnik'],
    places: ['Guardian Stones'],
    items: [],
    beats: [
      { as: one('talk', 'Hesta'), after: [] },
      { as: one('talk', 'Rulnik'), after: [0] },
      { as: one('arrive', 'Guardian Stones'), after: [1] },
      { as: one('clear', 'bandits'), after: [2] },
      { as: one('talk', 'Hesta'), after: [3], ends: 'complete' },
      { as: one('kill', 'Rulnik'), after: [], ends: 'fail', optional: true },
    ],
    links: [
      { line: 'Good. Bring him back in one piece', beat: 0 },
      { line: "Then I'm in good hands", beat: 1 },
      { line: "Thank you. Here's your hundred", beat: 4 },
    ],
  },
  {
    doc: 'questline-cartographer.md',
    part: 2,
    people: ['Varro Tullius', 'Hulda', 'Hesta Coldwater'],
    places: ['Bannered Mare'],
    items: ["Varro's Strongbox Key", "Varro's Ledger"],
    beats: [
      { as: one('pickup', "Varro's Strongbox Key"), after: [], optional: true },
      { as: [{ does: 'read', target: "Varro's Ledger" }, { does: 'pickup', target: "Varro's Ledger" }], after: [0] },
      { as: one('talk', 'Hesta'), after: [1] },
      { as: one('wait', null), after: [2] },
      { as: one('talk', 'Hesta'), after: [3], ends: 'complete' },
    ],
    links: [
      { line: 'Give it here. Gods.', beat: 2 },
      { line: "Rest. You'll need it.", beat: 4 },
    ],
  },
  {
    doc: 'questline-cartographer.md',
    part: 3,
    people: ['Varro Tullius', 'Gerda Stone-Arm', 'Hesta Coldwater'],
    places: ['Valtheim Towers'],
    items: ['Coldwater Survey of the Rift'],
    beats: [
      { as: one('arrive', 'Valtheim Towers'), after: [], optional: true },
      { as: one('talk', 'Varro'), after: [0] },
      { as: one('kill', 'Varro'), after: [0] },
      { as: one('talk', 'Hesta'), after: [1, 2], ends: 'complete' },
    ],
    links: [
      { line: '...Fine. Cyrodiil is warmer anyway', beat: 1 },
      { line: "It's done. Varro won't trouble you again.", beat: 3 },
    ],
  },
  {
    doc: 'synopsis.md',
    people: ['Gerdur', 'Ragnvald'],
    places: ['Riverwood', 'Guardian Stones'],
    items: ['note', "Gerdur's ledger"],
    beats: [
      { as: one('talk', 'Gerdur'), after: [] },
      { as: [{ does: 'read', target: 'note' }, { does: 'arrive', target: 'Riverwood' }, { does: 'pickup', target: 'note' }], after: [0] },
      { as: [{ does: 'kill', target: 'Ragnvald' }, { does: 'clear', target: 'bandits' }], after: [1] },
      { as: one('pickup', "Gerdur's ledger"), after: [2], optional: true },
      { as: one('talk', 'Ragnvald'), after: [1] },
      { as: one('talk', 'Gerdur'), after: [3, 4], ends: 'complete' },
    ],
  },
  {
    doc: 'prose.md',
    people: ['Tilda Grey-Hand'],
    places: ['Bleak Falls Barrow'],
    items: ['letter', 'axe'],
    beats: [
      { as: one('talk', 'Tilda'), after: [] },
      { as: [{ does: 'pickup', target: 'letter' }, { does: 'read', target: 'letter' }, { does: 'arrive', target: 'Bleak Falls Barrow' }], after: [0] },
      { as: one('talk', 'Tilda'), after: [1], ends: 'complete' },
    ],
  },
  {
    doc: 'nexus.md',
    people: ['Captain Ulfgar', 'Hrothmar'],
    places: ['Drunken Huntsman', 'Halted Stream Camp'],
    items: ["guard's badge", "Watchman's Oath"],
    beats: [
      { as: one('talk', 'Ulfgar'), after: [] },
      { as: one('arrive', 'Halted Stream Camp'), after: [0], optional: true },
      { as: one('kill', 'Hrothmar'), after: [1] },
      { as: one('talk', 'Hrothmar'), after: [1] },
      { as: one('talk', 'Ulfgar'), after: [2, 3], ends: 'complete' },
    ],
  },
  {
    doc: 'screenplay.md',
    people: ['Hulda', 'Sabjorn'],
    places: ['Bannered Mare', 'Honningbrew Meadery'],
    items: ['cask'],
    beats: [
      { as: one('talk', 'Hulda'), after: [] },
      { as: one('talk', 'Sabjorn'), after: [0] },
      { as: one('clear', 'skeevers'), after: [1] },
      { as: [{ does: 'talk', target: 'Sabjorn' }, { does: 'pickup', target: 'cask' }], after: [2] },
      { as: one('talk', 'Hulda'), after: [3, 5], ends: 'complete' },
      // Talked into handing it over: no skeevers to clear.
      { as: one('talk', 'Sabjorn'), after: [0], optional: true },
    ],
    links: [
      { line: 'Would you? Sabjorn at the meadery', beat: 0 },
      { line: "You will? Then the cask's yours", beat: 1 },
      { line: 'Fine, fine. Here.', beat: 5 },
      { line: 'Finally! Here, for your trouble.', beat: 4 },
    ],
  },
];
