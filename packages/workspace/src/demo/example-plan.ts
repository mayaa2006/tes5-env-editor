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
    startsWhen: null,
    characters: [
      { key: 'brynja', name: 'Brynja', existing: 'DemoInnkeeper', basedOn: null, sex: 'female', race: null, role: 'Innkeeper who lost the ring and gives the quest', appearance: 'As she is', look: null, voice: null, locationKey: null, spot: null, essential: null, className: null, level: null, outfit: null, factions: [], inventory: [], routine: [], combat: null, roles: null, relationships: [] },
      {
        key: 'eirik',
        name: 'Eirik',
        existing: null,
        basedOn: null,
        sex: 'male',
        race: 'DemoHumanRace',
        role: 'Traveller who saw where the ring went',
        appearance: 'Weathered traveller, short hair, full beard, in blue fine clothes and boots',
        look: { weight: 70, height: 1.02, hair: 'short', hairColor: 'brown', facialHair: 'full beard', eyes: null, scar: null },
        voice: 'MaleCommoner',
        locationKey: 'tavern',
        spot: 'by the barrels',
        essential: false,
        className: 'Warrior',
        level: 6,
        outfit: { items: ['Blue Fine Clothes', 'Leather Boots'], saveAs: 'EirikTravelOutfit' },
        factions: [{ faction: 'Townsfolk', rank: 0 }],
        inventory: [{ item: 'Bottle of Mead', count: 2 }],
        routine: [
          { activity: 'sandbox', where: 'tavern', hours: { from: 8, to: 22 }, fromStage: null, untilStage: null, line: null },
          { activity: 'sleep', where: 'tavern', hours: { from: 22, to: 8 }, fromStage: null, untilStage: null, line: null },
        ],
        combat: null,
        roles: null,
        relationships: [],
      },
    ],
    locations: [{ key: 'tavern', name: 'The Demo Tavern', existing: 'DemoTavern', description: 'The tavern Brynja runs', layoutLike: null, doorFrom: null }],
    encounters: [],
    items: [{ key: 'ring', name: "Brynja's Ring", kind: 'misc', existing: null, basedOn: null, value: 50, startsWith: 'location', startsAtKey: 'tavern', spot: 'on a table', copies: null, text: null, lockedWith: null }],
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
      { from: 0, to: 10, kind: 'talk', targetKey: null, count: null, hours: null, note: 'Brynja asks the player to find the ring' },
      { from: 10, to: 20, kind: 'pickup', targetKey: 'ring', count: null, hours: null, note: 'The player finds the ring' },
      { from: 20, to: 100, kind: 'talk', targetKey: null, count: null, hours: null, note: 'The player returns the ring' },
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
BRYNJA: Oh, thank the gods! Here, you've earned this. [gesture applaud] [takes ring x1] [gives gold x100] [stage 100] [emotion happy] [goodbye]`,
      },
      {
        title: 'Eirik',
        screenplay: `PLAYER: Have you seen a ring around here? [if stage 10]
EIRIK: A ring? Ha! Saw something shiny roll across a table earlier. Didn't think it was worth getting up for. [gesture point] [goodbye]`,
      },
    ],
    rewards: [],
    animations: [{ atStage: 20, characterKey: 'eirik', gesture: 'laugh' }],
    events: [],
    failures: [],
    assumptions: ['The ring starts on a table in the tavern', 'Brynja pays 100 gold in her dialogue rather than as a separate reward'],
    questions: ['Should Eirik be suspicious, or just lazy?'],
  };
}

/**
 * More worked examples for free AIs, which copy an example far better than
 * they follow rules: each shows parts of the plan the ring quest doesn't
 * (fighting, a new place, a quest that starts from a note, two endings,
 * failure; or characters made and changed with no quest at all). The one
 * closest to the author's text is sent with it. Editor IDs are vanilla
 * Skyrim's where possible; the prompt says to use only the load order's.
 */
export const EXAMPLE_RESCUE_DOCUMENT = `The Miller's Daughter

A note pinned up in the Sleeping Giant Inn: bandits have taken Ylva, the miller Hrodulf's daughter, to a cave up the river. Reading it starts the quest.

The cave is new: Riverside Cave. Four bandits wait inside, and their leader Skarn, a big Nord with a battleaxe, by the fire at the back. Ylva is tied up near him. If Ylva dies, the quest fails.

When the bandits are dead, Skarn throws down his axe and begs for his life. The player can let him go or kill him. Then Ylva follows the player back to her father at the inn. Hrodulf pays 300 gold, and if Skarn is dead he also gives the player his old hunting bow.`;

export function exampleRescuePlan(): QuestPlan {
  return {
    title: "The Miller's Daughter",
    editorId: 'MillersDaughterQuest',
    summary: 'Rescue Ylva from the bandits in Riverside Cave, decide what happens to their leader Skarn, and bring her home to her father.',
    startsWithGame: false,
    startsWhen: { kind: 'read', targetKey: 'note', quest: null, stage: null },
    characters: [
      {
        key: 'hrodulf',
        name: 'Hrodulf',
        existing: null,
        basedOn: null,
        sex: 'male',
        race: 'NordRace',
        role: 'Miller whose daughter was taken; pays the reward',
        appearance: 'Old, worried, grey hair and beard, in plain farm clothes',
        look: { weight: 40, height: 1, hair: 'short', hairColor: 'grey', facialHair: 'full beard', eyes: 'blue', scar: null },
        voice: 'MaleCommoner',
        locationKey: 'inn',
        spot: 'at a table near the fire',
        essential: true,
        className: 'Citizen',
        level: 5,
        outfit: { items: ['Farm Clothes', 'Boots'], saveAs: null },
        factions: [],
        inventory: [],
        routine: [
          { activity: 'sandbox', where: 'inn', hours: { from: 7, to: 23 }, fromStage: null, untilStage: null, line: null },
          { activity: 'sleep', where: 'inn', hours: { from: 23, to: 7 }, fromStage: null, untilStage: null, line: null },
        ],
        combat: null,
        roles: null,
        relationships: [{ with: 'ylva', rank: 'confidant' }],
      },
      {
        key: 'ylva',
        name: 'Ylva',
        existing: null,
        basedOn: null,
        sex: 'female',
        race: 'NordRace',
        role: "Hrodulf's daughter, held by the bandits",
        appearance: 'Young, frightened, long blonde braids, ragged clothes',
        look: { weight: 30, height: 0.97, hair: 'long braids', hairColor: 'blonde', facialHair: null, eyes: 'grey', scar: null },
        voice: 'FemaleYoungEager',
        locationKey: 'cave',
        spot: 'tied up by the fire at the back',
        essential: false,
        className: 'Citizen',
        level: 3,
        outfit: { items: ['Roughspun Tunic', 'Footwraps'], saveAs: null },
        factions: [],
        inventory: [],
        routine: [
          { activity: 'stay', where: 'cave', hours: null, fromStage: null, untilStage: 30, line: null },
          { activity: 'follow', where: null, hours: null, fromStage: 30, untilStage: 100, line: null },
        ],
        combat: { hostile: false, levelScaled: null, skills: [], spells: [], perks: [], combatStyle: null },
        roles: null,
        relationships: [{ with: 'hrodulf', rank: 'confidant' }],
      },
      {
        key: 'skarn',
        name: 'Skarn',
        existing: null,
        basedOn: null,
        sex: 'male',
        race: 'NordRace',
        role: 'Bandit leader who took Ylva',
        appearance: 'Big and scarred, shaved head, red beard, iron armour and a battleaxe',
        look: { weight: 100, height: 1.08, hair: 'bald', hairColor: 'red', facialHair: 'full beard', eyes: 'brown', scar: 'scar across left eye' },
        voice: 'MaleBrute',
        locationKey: 'cave',
        spot: 'by the fire at the back',
        essential: false,
        className: 'Warrior',
        level: null,
        outfit: { items: ['Iron Armor', 'Iron Boots', 'Iron Battleaxe'], saveAs: 'SkarnBanditOutfit' },
        factions: [],
        inventory: [{ item: 'Gold', count: 40 }],
        routine: [{ activity: 'forcegreet', where: null, hours: null, fromStage: 20, untilStage: 30, line: 'Wait! Mercy! Take the girl, just let me live!' }],
        combat: { hostile: true, levelScaled: { min: 6, max: 30 }, skills: [{ skill: 'Two-handed', value: 55 }, { skill: 'Heavy Armor', value: 45 }], spells: [], perks: ['Barbarian'], combatStyle: 'Berserker' },
        roles: null,
        relationships: [],
      },
    ],
    locations: [
      { key: 'inn', name: 'Sleeping Giant Inn', existing: 'RiverwoodSleepingGiantInn', description: 'The inn where the note is pinned up and Hrodulf waits', layoutLike: null, doorFrom: null },
      { key: 'cave', name: 'Riverside Cave', existing: null, description: 'A damp bandit hideout up the river', layoutLike: 'EmbershardMine', doorFrom: null },
    ],
    items: [
      { key: 'note', name: 'Plea for Help', kind: 'book', existing: null, basedOn: null, value: 0, startsWith: 'location', startsAtKey: 'inn', spot: 'on the bar', copies: null, text: null, lockedWith: null },
      { key: 'bow', name: "Hrodulf's Hunting Bow", kind: 'weapon', existing: null, basedOn: 'Hunting Bow', value: 120, startsWith: 'character', startsAtKey: 'hrodulf', spot: null, copies: null, text: null, lockedWith: null },
    ],
    encounters: [{ key: 'bandits', what: 'LvlBanditMelee1H', count: 4, locationKey: 'cave', spot: 'around the entrance' }],
    stages: [
      { index: 0, journal: "I found a note in the Sleeping Giant Inn. Bandits have taken Ylva, the miller's daughter, to Riverside Cave.", startsQuest: true, completesQuest: false, failsQuest: false },
      { index: 10, journal: 'I have reached Riverside Cave. The bandits holding Ylva are somewhere inside.', startsQuest: false, completesQuest: false, failsQuest: false },
      { index: 20, journal: 'I killed the bandits. Their leader, Skarn, threw down his axe and begged me to spare him.', startsQuest: false, completesQuest: false, failsQuest: false },
      { index: 25, journal: 'I refused to spare Skarn, and he took up his axe again.', startsQuest: false, completesQuest: false, failsQuest: false },
      { index: 30, journal: 'Ylva is free. I should take her back to her father at the Sleeping Giant Inn.', startsQuest: false, completesQuest: false, failsQuest: false },
      { index: 90, journal: 'Ylva is dead. I failed to save her.', startsQuest: false, completesQuest: false, failsQuest: true },
      { index: 100, journal: 'I brought Ylva home and let Skarn go. Hrodulf paid me for my trouble.', startsQuest: false, completesQuest: true, failsQuest: false },
      { index: 110, journal: 'I brought Ylva home, and Skarn will trouble no one again. Hrodulf paid me and gave me his old hunting bow.', startsQuest: false, completesQuest: true, failsQuest: false },
    ],
    objectives: [
      { index: 0, text: 'Rescue Ylva from Riverside Cave', shownAtStage: 0, completedAtStage: 30, targetKey: 'cave' },
      { index: 20, text: 'Decide what to do with Skarn', shownAtStage: 20, completedAtStage: 30, targetKey: 'skarn' },
      { index: 30, text: 'Take Ylva back to Hrodulf', shownAtStage: 30, completedAtStage: 100, targetKey: 'hrodulf' },
    ],
    steps: [
      { from: 0, to: 10, kind: 'arrive', targetKey: 'cave', count: null, hours: null, note: 'The player enters the cave' },
      { from: 10, to: 20, kind: 'clear', targetKey: 'bandits', count: null, hours: null, note: 'Every bandit is dead' },
      { from: 20, to: 30, kind: 'talk', targetKey: null, count: null, hours: null, note: 'The player lets Skarn go' },
      { from: 20, to: 25, kind: 'talk', targetKey: null, count: null, hours: null, note: 'The player refuses to spare Skarn' },
      { from: 25, to: 30, kind: 'death', targetKey: 'skarn', count: null, hours: null, note: 'Skarn is killed' },
      { from: 30, to: 100, kind: 'talk', targetKey: null, count: null, hours: null, note: 'Ylva is home and Skarn was spared' },
      { from: 30, to: 110, kind: 'talk', targetKey: null, count: null, hours: null, note: 'Ylva is home and Skarn is dead' },
    ],
    conversations: [
      {
        title: 'Skarn',
        screenplay: `PLAYER: Go, and never come back. [if stage 20] [remember spared]
SKARN: You won't see me again. I swear it on my mother's grave. [emotion fear] [stage 30] [goodbye]
PLAYER: You'll pay for what you did. [if stage 20]
SKARN: Then I'll take you with me! [emotion angry] [stage 25] [goodbye]`,
      },
      {
        title: 'Ylva',
        screenplay: `GREETING: [if stage 30]
YLVA: Is it over? Please, take me home to my father.
PLAYER: Your father sent me. [if stage 10]
YLVA: Gods, thank you. Get me out of here before they come back. [emotion fear] [goodbye]`,
      },
      {
        title: 'Hrodulf',
        screenplay: `PLAYER: Ylva is safe. Skarn ran off. [if stage 30] [if chose spared]
HRODULF: My girl! You let that animal live... but you brought her home. Here, it's all I have. [emotion happy] [gives gold x300] [stage 100] [goodbye]
PLAYER: Ylva is safe, and Skarn is dead. [if stage 30] [if not chose spared]
HRODULF: My girl! And that monster gone. Take this, and my old bow. It served me well. [emotion happy] [gesture applaud] [gives gold x300] [gives bow x1] [stage 110] [goodbye]
GREETING: [if stage 0]
HRODULF: My daughter... have you seen my Ylva? [emotion sad]`,
      },
    ],
    rewards: [],
    animations: [{ atStage: 30, characterKey: 'ylva', gesture: 'pray' }],
    events: [
      { atStage: 20, kind: 'friendly', targetKey: 'skarn', toKey: null, what: null, count: null, note: 'Skarn stops fighting and begs for his life' },
      { atStage: 25, kind: 'hostile', targetKey: 'skarn', toKey: null, what: null, count: null, note: 'Skarn attacks again' },
    ],
    failures: [{ kind: 'death', targetKey: 'ylva', days: null, fromStage: null, failStage: 90, note: 'Ylva dies' }],
    assumptions: [
      'The note lies on the bar of the Sleeping Giant Inn, and Hrodulf waits there',
      'The cave is copied from Embershard Mine',
      'Skarn levels with the player from level 6 to 30',
      'Hrodulf pays in his dialogue rather than as a separate reward',
    ],
    questions: ['Where should the entrance to Riverside Cave be? It has no outside door yet.'],
  };
}

export const EXAMPLE_CHARACTERS_DOCUMENT = `Add Ingrid, a Redguard blacksmith, to the Sleeping Giant Inn. She's tall and strong, with short black hair and a burn scar on her cheek, and wears a blacksmith's apron. She sits by the fire in the day and sleeps there at night.

She sells weapons from 8 in the morning to 8 at night, trains Smithing up to expert, and can become a follower. She fights with a sword and shield and is good at it.

Also give Orgnar, the innkeeper, a full beard, and make him essential.`;

export function exampleCharactersPlan(): QuestPlan {
  return {
    title: 'Ingrid and Orgnar',
    editorId: 'IngridOrgnarChanges',
    summary: 'A new blacksmith, Ingrid, at the Sleeping Giant Inn, and changes to Orgnar. No quest.',
    startsWithGame: false,
    startsWhen: null,
    characters: [
      {
        key: 'ingrid',
        name: 'Ingrid',
        existing: null,
        basedOn: null,
        sex: 'female',
        race: 'RedguardRace',
        role: 'Travelling blacksmith who sells weapons, trains Smithing and can follow the player',
        appearance: 'Tall and strong, short black hair, burn scar on her cheek, blacksmith apron',
        look: { weight: 90, height: 1.05, hair: 'short', hairColor: 'black', facialHair: null, eyes: 'brown', scar: 'burn scar on cheek' },
        voice: 'FemaleCommander',
        locationKey: 'inn',
        spot: 'by the fire',
        essential: false,
        className: null,
        level: 20,
        outfit: { items: ["Blacksmith's Apron", 'Boots'], saveAs: 'IngridBlacksmithOutfit' },
        factions: [],
        inventory: [
          { item: 'Steel Sword', count: 1 },
          { item: 'Steel Shield', count: 1 },
        ],
        routine: [
          { activity: 'sandbox', where: 'inn', hours: { from: 6, to: 22 }, fromStage: null, untilStage: null, line: null },
          { activity: 'sleep', where: 'inn', hours: { from: 22, to: 6 }, fromStage: null, untilStage: null, line: null },
        ],
        combat: { hostile: false, levelScaled: null, skills: [{ skill: 'One-handed', value: 60 }, { skill: 'Block', value: 55 }, { skill: 'Smithing', value: 80 }], spells: [], perks: ['Armsman', 'Shield Wall'], combatStyle: null },
        roles: { follower: true, marriage: false, innkeeper: false, merchant: { sells: 'weapons', hours: { from: 8, to: 20 } }, trainer: { skill: 'Smithing', maxLevel: 75 } },
        relationships: [],
      },
      {
        key: 'orgnar',
        name: 'Orgnar',
        existing: 'Orgnar',
        basedOn: null,
        sex: null,
        race: null,
        role: 'Innkeeper of the Sleeping Giant Inn',
        appearance: 'As he is, with a full beard',
        look: { weight: null, height: null, hair: null, hairColor: null, facialHair: 'full beard', eyes: null, scar: null },
        voice: null,
        locationKey: null,
        spot: null,
        essential: true,
        className: null,
        level: null,
        outfit: null,
        factions: [],
        inventory: [],
        routine: [],
        combat: null,
        roles: null,
        relationships: [],
      },
    ],
    locations: [{ key: 'inn', name: 'Sleeping Giant Inn', existing: 'RiverwoodSleepingGiantInn', description: 'Where Ingrid stays', layoutLike: null, doorFrom: null }],
    items: [],
    encounters: [],
    stages: [],
    objectives: [],
    steps: [],
    conversations: [],
    rewards: [],
    animations: [],
    events: [],
    failures: [],
    assumptions: ['"Up to expert" means Smithing training to level 75', 'Ingrid is a skilled fighter: One-handed 60 and Block 55', 'Her sword and shield are carried, not part of her outfit'],
    questions: [],
  };
}

/**
 * The worked examples, with words that suggest each. A free AI gets the one
 * whose words its text uses most (the ring quest when nothing matches).
 */
export const PLAN_EXAMPLES: { id: string; document: string; plan: () => QuestPlan; words: string[] }[] = [
  { id: 'ring', document: EXAMPLE_QUEST_DOCUMENT, plan: exampleQuestPlan, words: ['lost', 'find', 'found', 'return', 'bring', 'ask', 'asks', 'deliver', 'fetch', 'letter', 'innkeeper', 'reward', 'pay', 'pays', 'gold'] },
  {
    id: 'rescue',
    document: EXAMPLE_RESCUE_DOCUMENT,
    plan: exampleRescuePlan,
    words: ['bandit', 'bandits', 'kill', 'kills', 'killed', 'fight', 'fights', 'attack', 'attacks', 'cave', 'ruin', 'tomb', 'dungeon', 'draugr', 'rescue', 'save', 'spare', 'fail', 'fails', 'dies', 'die', 'dead', 'note', 'reads', 'enemy', 'enemies', 'ambush', 'boss', 'leader', 'choice', 'choose', 'either'],
  },
  {
    id: 'characters',
    document: EXAMPLE_CHARACTERS_DOCUMENT,
    plan: exampleCharactersPlan,
    words: ['add', 'create', 'make', 'change', 'give', 'wears', 'wear', 'sells', 'merchant', 'shop', 'trains', 'trainer', 'follower', 'marry', 'marriage', 'essential', 'beard', 'hair', 'scar', 'outfit', 'armour', 'armor', 'looks', 'tall', 'short', 'blacksmith'],
  },
];

/** The worked example closest to the author's text. */
export function pickPlanExample(text: string): (typeof PLAN_EXAMPLES)[number] {
  const words = (text.toLowerCase().match(/[a-z]+/g) ?? []).reduce((m, w) => m.set(w, (m.get(w) ?? 0) + 1), new Map<string, number>());
  const score = (e: (typeof PLAN_EXAMPLES)[number]) => e.words.reduce((n, w) => n + (words.get(w) ?? 0), 0);
  // A text that asks for characters but describes no quest gets the characters example even when a word or two match the others.
  const questy = /\b(quest|stage|journal|objective|reward|then the player|asks the player|the player must)\b/i.test(text);
  const weigh = (e: (typeof PLAN_EXAMPLES)[number]) => score(e) + (e.id === 'characters' && score(e) > 0 && !questy ? 1 : 0);
  let best = PLAN_EXAMPLES[0]!;
  for (const e of PLAN_EXAMPLES) if (weigh(e) > weigh(best)) best = e;
  return best;
}
