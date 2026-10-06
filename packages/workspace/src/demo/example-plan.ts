/**
 * An example design document and the plan Claude would make from it, for
 * the demo (which has no API key) and for tests.
 */
import type { QuestPlan } from '../questplan';

export const EXAMPLE_QUEST_DOCUMENT = `The Innkeeper's Ring

Brynja, who runs the Demo Tavern, has lost her mother's ring. If the player asks her for work, she tells them about it and asks them to look around the tavern.

A traveller called Eirik is drinking in the tavern. If the player asks him about the ring, he admits he saw it fall behind the bar and laughs about it.

The ring is on one of the tables. When the player picks it up, they should take it back to Brynja. She is overjoyed, takes the ring and pays 100 gold.`;

export function exampleQuestPlan(): QuestPlan {
  return {
    title: "The Innkeeper's Ring",
    editorId: 'InnkeeperRingQuest',
    summary: 'Find Brynja’s lost ring in the Demo Tavern and return it to her.',
    startsWithGame: true,
    characters: [
      { key: 'brynja', name: 'Brynja', existing: 'DemoInnkeeper', sex: 'female', race: null, role: 'Innkeeper who lost the ring and gives the quest', appearance: 'As she is', voice: null, locationKey: null, essential: true },
      { key: 'eirik', name: 'Eirik', existing: null, sex: 'male', race: 'DemoHumanRace', role: 'Traveller who saw where the ring went', appearance: 'Weathered traveller, short hair', voice: 'MaleCommoner', locationKey: 'tavern', essential: false },
    ],
    locations: [{ key: 'tavern', name: 'The Demo Tavern', existing: 'DemoTavern', description: 'The tavern Brynja runs' }],
    items: [{ key: 'ring', name: "Brynja's Ring", kind: 'misc', existing: null, value: 50, startsWith: 'location', startsAtKey: 'tavern' }],
    stages: [
      { index: 0, journal: '', startsQuest: true, completesQuest: false, failsQuest: false },
      { index: 10, journal: 'Brynja, the innkeeper of the Demo Tavern, has lost her mother’s ring. She asked me to look for it around the tavern.', startsQuest: false, completesQuest: false, failsQuest: false },
      { index: 20, journal: 'I found Brynja’s ring. I should return it to her.', startsQuest: false, completesQuest: false, failsQuest: false },
      { index: 100, journal: 'I returned the ring to Brynja, who paid me for my trouble.', startsQuest: false, completesQuest: true, failsQuest: false },
    ],
    objectives: [
      { index: 10, text: 'Find Brynja’s ring', shownAtStage: 10, completedAtStage: 20, targetKey: 'ring' },
      { index: 20, text: 'Return the ring to Brynja', shownAtStage: 20, completedAtStage: 100, targetKey: 'brynja' },
    ],
    steps: [
      { from: 0, to: 10, kind: 'talk', targetKey: null, note: 'Brynja asks the player to find the ring' },
      { from: 10, to: 20, kind: 'pickup', targetKey: 'ring', note: 'The player finds the ring' },
      { from: 20, to: 100, kind: 'talk', targetKey: null, note: 'The player returns the ring' },
    ],
    conversations: [
      {
        title: 'Brynja',
        screenplay: `PLAYER: Got any work for me?
BRYNJA: I've lost my mother's ring. It was here this morning, I swear it. [if stage 0] [emotion sad]
  PLAYER: I'll look for it. [stage 10]
    BRYNJA: Thank you. Try the tables, I was clearing them all morning. [goodbye]
  PLAYER: Not now.
    BRYNJA: If you change your mind, I'll be here. [goodbye]
PLAYER: I found your ring. [if stage 20]
BRYNJA: Oh, thank the gods! Here, you've earned this. [takes ring x1] [gives gold x100] [stage 100] [emotion happy] [goodbye]`,
      },
      {
        title: 'Eirik',
        screenplay: `PLAYER: Have you seen a ring around here? [if stage 10]
EIRIK: A ring? Ha! Saw something shiny roll across a table earlier. Didn't think it was worth getting up for. [goodbye]`,
      },
    ],
    rewards: [],
    assumptions: ['The ring starts on a table in the tavern', 'Brynja pays 100 gold in her dialogue rather than as a separate reward'],
    questions: ['Should Eirik be suspicious, or just lazy?'],
  };
}
