import { describe, expect, it } from 'vitest';
import { exampleQuestPlan, walkIssues, walkPlan, type QuestPlan } from '../src';

/** The example plan with its stages, steps and dialogue replaced. */
function plan(over: Partial<QuestPlan>): QuestPlan {
  const p = exampleQuestPlan();
  return { ...p, events: [], rewards: [], failures: [], animations: [], ...over };
}
const stage = (index: number, ends?: 'complete' | 'fail') => ({ index, journal: ends === 'complete' ? 'Done.' : ends === 'fail' ? 'Failed.' : '', startsQuest: index === 0, completesQuest: ends === 'complete', failsQuest: ends === 'fail' });

describe('playing a plan through', () => {
  it('finds the way through the example quest', () => {
    const w = walkPlan(exampleQuestPlan());
    expect(w.partial).toBe(false);
    expect(w.endings.map((e) => [e.stage, e.fails])).toEqual([[100, false]]);
    expect(w.endings[0]!.path.steps).toEqual(['Talk to Brynja: “Got any work for me?”', 'Talk to Brynja: “I\'ll look for it.”', "Pick up Brynja's Ring", 'Talk to Brynja: “I found your ring.”']);
    expect(w.stuck).toEqual([]);
    expect(walkIssues(w)).toEqual([]);
  });

  it('says where the player gets stuck: the line that moves it on needs an earlier stage', () => {
    // Collecting the pages (stage 20) should be followed by returning them, but the return line needs stage 10.
    const p = plan({
      stages: [stage(0), stage(10), stage(20), stage(30, 'complete')],
      steps: [
        { from: 0, to: 10, kind: 'talk', targetKey: 'brynja', count: null, hours: null, note: '' },
        { from: 10, to: 20, kind: 'pickup', targetKey: 'ring', count: null, hours: null, note: '' },
        { from: 20, to: 30, kind: 'talk', targetKey: 'brynja', count: null, hours: null, note: '' },
      ],
      conversations: [{ title: 'Brynja', screenplay: 'PLAYER: Any work? [if stage 0]\nBRYNJA: Find my ring. [stage 10]\nPLAYER: Here it is. [if stage 10]\nBRYNJA: Thanks. [stage 30]' }],
    });
    const w = walkPlan(p);
    expect(w.stuck.map((s) => [s.stage, s.path.steps])).toEqual([[20, ['Talk to Brynja: “Any work?”', "Pick up Brynja's Ring"]]]);
    // (Saying thanks before picking it up does finish it: the walkthrough finds that way too.)
    expect(w.endings.map((e) => e.path.steps)).toEqual([['Talk to Brynja: “Any work?”', 'Talk to Brynja: “Here it is.”']]);
    expect(walkIssues(w).map((i) => i.message)).toEqual(['Played through, the quest can get stuck at stage 20: nothing the player can do moves it on']);
  });

  it('tries a persuasion both ways, and someone who left says nothing more', () => {
    const p = plan({
      stages: [stage(0), stage(10), stage(20), stage(30, 'complete'), stage(40, 'complete')],
      steps: [],
      conversations: [
        {
          title: 'Brynja',
          screenplay: [
            'PLAYER: Pay me more. [if stage 0] [persuade 50]',
            '  BRYNJA: Fine, 250. [stage 10]',
            '  BRYNJA: No. Take it or leave it. [stage 20] [leaves]',
            'PLAYER: Done. [if stage 10]',
            'BRYNJA: Here you are. [stage 30]',
            'PLAYER: Done. [if stage 20]',
            'BRYNJA: You found me anyway. [stage 40]',
          ].join('\n'),
        },
      ],
    });
    const w = walkPlan(p);
    expect(w.endings.map((e) => e.stage)).toEqual([30]);
    // Not persuaded, she leaves for good: nothing finishes the quest that way.
    expect(w.stuck.map((s) => [s.stage, s.path.steps])).toEqual([[20, ['Talk to Brynja: “Pay me more.” (not persuaded)']]]);
    expect(w.unreached).toEqual([40]);
    expect(w.unsaid).toEqual(['Brynja: “You found me anyway.”']);
  });

  it('fails the quest when someone it watches dies, and says when a line moves it back', () => {
    const p = plan({
      stages: [stage(0), stage(10), stage(20, 'complete'), stage(90, 'fail')],
      steps: [{ from: 0, to: 10, kind: 'arrive', targetKey: 'tavern', count: null, hours: null, note: '' }],
      failures: [{ kind: 'death', targetKey: 'brynja', days: null, fromStage: null, failStage: 90, note: '' }],
      conversations: [{ title: 'Brynja', screenplay: 'PLAYER: Hello. [if stage 10]\nBRYNJA: Start over. [stage 5]\nPLAYER: Bye. [if stage 10]\nBRYNJA: Done. [stage 20]' }],
    });
    p.stages.push(stage(5));
    const w = walkPlan(p);
    expect(w.endings.map((e) => [e.stage, e.fails])).toEqual([
      [20, false],
      [90, true],
    ]);
    expect(w.endings[1]!.path.steps).toEqual(['Brynja is killed']);
    expect(w.backwards).toEqual([{ line: 'Brynja: “Start over.”', from: 10, to: 5 }]);
  });
});
