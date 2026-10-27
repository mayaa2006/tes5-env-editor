/**
 * The beat reader's yes-or-no questions (YES_NO in beatreader.ts), each asked on real sentences from the test
 * documents with the answer it should get. A wording is kept only if it reads its cases right on every model offered:
 * run this once per model and compare.
 *
 *   npx tsx apps/studio/test/models/question-probe.ts <base url> <model> [--only someoneElse,isPlayer] [--variants]
 *
 * --variants also asks the other wordings being tried (VARIANTS), each on the same cases.
 * Prints each question's score and the cases it got wrong, and a JSON line with the scores at the end.
 */
import { QuestPlanner, READ_RULES, TWO_WAY, YES_NO, type AiProvider } from '@tes5/workspace';
import { z } from 'zod';

const [url, model, ...rest] = process.argv.slice(2);
if (!url || !model) throw new Error('usage: question-probe.ts <base url> <model> [--only a,b]');
const only = rest.includes('--only') ? rest[rest.indexOf('--only') + 1]?.split(',') : undefined;
const withVariants = rest.includes('--variants');

type Q = keyof typeof YES_NO;
type Case = { q: Q; args: string[]; yes: boolean };

/** Each case: the question, its arguments as the reader passes them, and the right answer. */
const CASES: Case[] = [
  // Directed lines: the note on the line (the Cartographer, the screenplay).
  { q: 'noteHappens', args: ["The case will be ruined, but it's the pages that matter. Bring me all three, and you'll have 150 septims.", 'the player takes the job'], yes: true },
  { q: 'noteHappens', args: ["Good. I'll hold you to it.", 'she remembers the promise'], yes: true },
  { q: 'noteHappens', args: ['Then stop wasting my firelight.', 'end the conversation'], yes: false },
  { q: 'noteHappens', args: ['Here, as agreed.', 'she takes the three pages and pays 150 gold, or 250 if persuaded; the quest is done'], yes: true },
  { q: 'noteHappens', args: ['Nice try. Think about my offer.', 'failure'], yes: false },
  { q: 'noteHappens', args: ["Then I'm in good hands. Lead the way.", 'Rulnik starts following; objective: take Rulnik to the Guardian Stones'], yes: true },
  { q: 'noteHappens', args: ["That's what I thought. Hesta needs to know.", 'objective: tell Hesta what happened'], yes: false },
  { q: 'noteHappens', args: ['Suits me.', 'Gerda and Varro attack'], yes: true },
  // Undirected lines: the answer, with what the player said.
  { q: 'lineMoves', args: ["Where's Embershard Mine again?", 'HESTA', "East along the road, then up into the hills on the left. You'll hear the bandits before you see them."], yes: false },
  { q: 'lineMoves', args: ['Seen anything strange lately?', 'LUCAN', 'An Imperial in fine clothes came in yesterday asking about "the map woman". Didn\'t buy anything, either.'], yes: false },
  { q: 'lineMoves', args: ["I'm looking for an Imperial called Varro.", 'Hulda', 'The Imperial? He keeps strange hours. Comes down after dark and drinks alone in the corner.'], yes: false },
  { q: 'lineMoves', args: ['Who are you?', 'VARRO', 'Varro Tullius. A collector of old things. Old maps, old debts. I pay well for both.'], yes: false },
  { q: 'lineMoves', args: ['I found your ring.', 'BRYNJA', 'Thank you! Here, take this gold for your trouble.'], yes: true },
  { q: 'lineMoves', args: ["I'll do it.", 'HESTA', "Good. Bring me all three pages and I'll pay you 150 septims."], yes: true },
  { q: 'lineMoves', args: ['Leave, or else.', 'GERDA', "Fine, fine. I'm going. You won't see me again."], yes: true },
  { q: 'lineMoves', args: ["It's done. The bandits are dead.", 'RAGNVALD', "You've done Riverwood a great service. Here's the reward I promised."], yes: true },
  // Which story sentence a line does.
  { q: 'sameAsStory', args: ['When the player takes the job', 'HESTA', "The case will be ruined, but it's the pages that matter. There were three of them. Bring me all three, and you'll have 150 septims.", 'the player takes the job'], yes: true },
  { q: 'sameAsStory', args: ['Once they have all three, the objective changes to returning to Hesta.', 'HESTA', 'Here, as agreed.', 'she takes the three pages and pays 150 gold, or 250 if persuaded; the quest is done'], yes: true },
  { q: 'sameAsStory', args: ['Ask for Hesta Coldwater, corner table by the fire.', 'HESTA', "Good. I'll hold you to it.", 'she remembers the promise'], yes: false },
  { q: 'sameAsStory', args: ['The player reports to Hesta, who pays 100 gold.', 'HESTA', "Thank you. Here's your hundred. Keep your eyes open.", 'she pays 100 gold; the quest is done'], yes: true },
  { q: 'sameAsStory', args: ['The player reports to Hesta, who pays 100 gold.', 'RULNIK', "Then I'm in good hands. Lead the way.", 'Rulnik starts following'], yes: false },
  { q: 'sameAsStory', args: ['The player meets Rulnik at his camp by the river and escorts him to the Guardian Stones', 'RULNIK', "Then I'm in good hands. Lead the way. I'll be right behind you.", 'Rulnik starts following; objective: take Rulnik to the Guardian Stones'], yes: true },
  { q: 'sameAsStory', args: ['The player brings the ledger to Hesta.', 'HESTA', 'Give it here. Gods. He paid them in coin and wrote it down like a grocer\'s bill.', 'she takes the ledger'], yes: true },
  { q: 'sameAsStory', args: ['The player brings the ledger to Hesta.', 'HESTA', "Rest. You'll need it.", 'the quest is done'], yes: false },
  // Whether the note says when the line is said.
  { q: 'noteCondition', args: ['he gives the player 200 gold and remembers the deal'], yes: false },
  { q: 'noteCondition', args: ['only if the player promised Hesta in Quest 1'], yes: true },
  { q: 'noteCondition', args: ['she takes the ledger'], yes: false },
  { q: 'noteCondition', args: ['success'], yes: false },
  { q: 'noteCondition', args: ['she takes the three pages and pays 150 gold, or 250 if persuaded; the quest is done'], yes: false },
  { q: 'noteCondition', args: ['only if the player took his money in Quest 3'], yes: true },
  { q: 'noteCondition', args: ['if Lucan was let go'], yes: true },
  { q: 'noteCondition', args: ['she remembers the promise'], yes: false },
  // A story passage read as adding nothing: does the player do anything in it?
  { q: 'passageActs', args: ["Varro carries Varro's Strongbox Key. The player has to get it (pickpocket it, or take it from him some other way). His strongbox is in the Bannered Mare, locked, and it holds Varro's Ledger. Reading the ledger moves the quest on."], yes: true },
  { q: 'passageActs', args: ['- The player finds the wrecked cart on the road just north of Riverwood. A note lies in the mud next to it.\n- At the Guardian Stones there\'s a bandit camp: three bandits and their leader, Ragnvald.\n- The player can kill them all, or talk Ragnvald down (Speech 35).'], yes: true },
  { q: 'passageActs', args: ['If the player asks her about the lantern, she tells them about Arn and begs them to find out what happened to him. Up at Bleak Falls Barrow, just inside the entrance, lies what\'s left of Arn, and on him a letter he never sent.'], yes: true },
  { q: 'passageActs', args: ['SCENE 3 — The cellar. Five skeevers. The cask of Honningbrew Mead sits by the stairs.'], yes: true },
  { q: 'passageActs', args: ['The ledger reads:\n\n> 3rd of Last Seed. 60 septims to Krev and two others, Embershard. One map case. Delivered three pages short. Paid half.'], yes: false },
  { q: 'passageActs', args: ['- **Hesta Coldwater**: a Nord cartographer in her fifties, sharp-tongued and proud. She rents a room at the Sleeping Giant Inn in Riverwood and works at the corner table by the fire.'], yes: false },
  // Story steps someone else does (the pair drops a beat only when the first says yes and the second no).
  { q: 'someoneElse', args: ['He stops following the player and walks back to the Sleeping Giant Inn on his own.'], yes: true },
  { q: 'someoneElse', args: ['he walks to Whiterun'], yes: true },
  { q: 'someoneElse', args: ['turns himself in'], yes: true },
  { q: 'someoneElse', args: ['The quest starts when the player reads a notice pinned to the bar of the Sleeping Giant Inn.'], yes: false },
  { q: 'someoneElse', args: ['Pick up the bloodied guard\'s badge lying in the grass outside Whiterun\'s western watchtower.'], yes: false },
  { q: 'someoneElse', args: ['Reading the ledger moves the quest on.'], yes: false },
  { q: 'isPlayer', args: ['When they reach the stones, four bandits ambush them: they appear around the stones as the player arrives', 'goes to the Guardian Stones'], yes: true },
  { q: 'isPlayer', args: ['Varro carries Varro\'s Strongbox Key. The player has to get it (pickpocket it, or take it from him some other way).', "picks up Varro's Strongbox Key"], yes: true },
  { q: 'isPlayer', args: ['He stops following the player and walks back to the Sleeping Giant Inn on his own.', 'waits'], yes: false },
  { q: 'isPlayer', args: ['he walks to Whiterun', 'goes to Whiterun'], yes: false },
  { q: 'isPlayer', args: ['turns himself in', 'goes to the Drunken Huntsman'], yes: false },
  { q: 'isPlayer', args: ['A note lies in the mud next to it: "Take the wood to the camp by the Guardian Stones. —R."', 'reads the note'], yes: true },
];

/** Two-way questions (TWO_WAY): their arguments and the answer they should get (0 the first, 1 the second). */
const TWO_WAY_CASES: { q: keyof typeof TWO_WAY; args: (string | number)[]; answer: 0 | 1 }[] = [
  { q: 'whoHas', args: ['Hesta Coldwater', 'Here, as agreed.', 'she takes the three pages and pays 150 gold, or 250 if persuaded; the quest is done', 'Torn Map Page'], answer: 0 },
  { q: 'whoHas', args: ['Varro Tullius', 'Sensible. Two hundred now, the rest when I have the pages.', 'he gives the player 200 gold and remembers the deal', 'Torn Map Page'], answer: 1 },
  { q: 'whoHas', args: ['Hesta Coldwater', "Give it here. Gods. He paid them in coin and wrote it down like a grocer's bill.", 'she takes the ledger', "Varro's Ledger"], answer: 0 },
  { q: 'whoHas', args: ['Tilda', 'Take this. It was his.', "she gives the player her late husband's axe", "Tilda's Axe"], answer: 1 },
  { q: 'whoHas', args: ['Gerdur', 'My ledger! Thank you.', 'she takes the ledger and pays 50 gold', "Gerdur's Ledger"], answer: 0 },
  { q: 'whoHas', args: ['Brynja', 'Here, keep it safe.', 'she gives the player the ring', "Brynja's Ring"], answer: 1 },
  // Gold read on a line: paid as it's said, or promised (the Cartographer's job and its payment).
  { q: 'goldNow', args: ['Hesta Coldwater', "The case will be ruined, but it's the pages that matter. There were three of them. Bring me all three, and you'll have 150 septims.", 'the player takes the job', 150], answer: 1 },
  { q: 'goldNow', args: ['Hesta Coldwater', 'Ha. Fine. 250, and not a coin more. Now go, before I change my mind.', 'success; the player takes the job, for 250', 250], answer: 1 },
  { q: 'goldNow', args: ['Hesta Coldwater', 'Here, as agreed.', 'she takes the three pages and pays 150 gold, or 250 if persuaded; the quest is done', 150], answer: 0 },
  { q: 'goldNow', args: ['Varro Tullius', 'Sensible. Two hundred now, the rest when I have the pages.', 'he gives the player 200 gold and remembers the deal', 200], answer: 0 },
  { q: 'goldNow', args: ['Hesta Coldwater', 'A hundred septims, and Rulnik\'s eternal gratitude, which is worth considerably less.', '', 100], answer: 1 },
  { q: 'goldNow', args: ['Hesta Coldwater', "Thank you. Here's your hundred. Keep your eyes open.", 'she pays 100 gold; the quest is done', 100], answer: 0 },
];

/**
 * Other wordings being tried, by question: the same arguments, a different question. A list is several questions,
 * read as yes when any of them is. (Tried and left out so far: for lineMoves, naming the acts first and asking whether
 * it's only talk; for sameAsStory, "the same step", "the same event" and "the person it's about"; for whether someone
 * takes an item, every yes-or-no wording, which is why it's a two-way question.)
 */
const VARIANTS: Partial<Record<Q, Record<string, (...a: string[]) => string | string[]>>> = {};

const ai: AiProvider = { kind: 'openai', url, model };
const planner = new QuestPlanner({ ai });
const scores: Record<string, { right: number; of: number; unsure?: number }> = {};
for (const c of CASES) {
  if (only && !only.includes(c.q)) continue;
  type Wording = (...a: string[]) => string | string[];
  const wordings: [string, Wording][] = [[c.q, YES_NO[c.q] as Wording], ...(withVariants ? Object.entries(VARIANTS[c.q] ?? {}).map(([k, f]) => [`${c.q}.${k}`, f] as [string, Wording]) : [])];
  for (const [name, f] of wordings) {
    let got: boolean | undefined;
    try {
      const qs = [f(...c.args)].flat();
      got = false;
      for (const q of qs) if ((await planner.ask(READ_RULES, q, z.object({ yes: z.boolean() }), 40, { exact: true })).yes) got = true;
    } catch {
      got = undefined;
    }
    const want = c.yes;
    const s = (scores[name] ??= { right: 0, of: 0 });
    s.of++;
    if (got === want) s.right++;
    else console.log(`✗ ${name}: expected ${want ? 'yes' : 'no'}, got ${got === undefined ? 'no answer' : got ? 'yes' : 'no'} — ${c.args.join(' | ').slice(0, 140)}`);
  }
}
// Two-way questions: asked both ways round, as the reader does; an answer only when both agree.
for (const c of TWO_WAY_CASES) {
  if (only && !only.includes(c.q)) continue;
  const { question, answers } = (TWO_WAY[c.q] as (...a: (string | number)[]) => { question: string; answers: readonly [string, string] })(...c.args);
  const ask = async (a: [string, string]) => (await planner.ask(READ_RULES, question, z.object({ answer: z.enum(a) }), 40, { exact: true })).answer;
  let got: string | undefined;
  try {
    const a = await ask([answers[0], answers[1]]);
    const b = await ask([answers[1], answers[0]]);
    got = a === b ? a : undefined;
  } catch {
    got = undefined;
  }
  const s = (scores[c.q] ??= { right: 0, of: 0, unsure: 0 });
  s.of++;
  if (got === answers[c.answer]) s.right++;
  else if (got === undefined) s.unsure = (s.unsure ?? 0) + 1;
  else console.log(`✗ ${c.q}: expected ${answers[c.answer]}, got ${got} — ${c.args.join(' | ').slice(0, 140)}`);
}
for (const [q, s] of Object.entries(scores)) console.log(`${q.padEnd(24)} ${s.right}/${s.of}${s.unsure ? ` (${s.unsure} left as read)` : ''}`);
console.log(JSON.stringify({ model, scores }));
