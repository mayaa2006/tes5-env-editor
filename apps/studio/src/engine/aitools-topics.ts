/**
 * Which tools a free AI is shown for a message. Every tool's description goes
 * with every request, and with all of them that's about 20,000 tokens: slow
 * on a PC without a strong graphics card, too much for small models to choose
 * from well, and over some free services' per-minute limits. So a free AI sees
 * a few tools it always needs, plus the topics the message (and what's open,
 * and the conversation so far) is about; it can ask for any other topic with
 * more_tools. Claude always sees everything.
 */
import type { AgentSession, AgentTool, ToolOffer } from '@tes5/workspace';

const ALWAYS = ['search_records', 'read_record', 'list_places', 'place_contents', 'quest_overview'];

/** Each topic: what it's for (shown to the AI), the words that call for it, and its tools. */
export const TOOL_TOPICS: Record<string, { about: string; words: RegExp; tools: string[] }> = {
  quests: {
    about: 'stages, journal, objectives, what moves a quest on, dialogue',
    words: /\b(quests?|stages?|journal|objectives?|dialogue|lines?|says?|said|talk|topics?|conversations?|greet\w*|starts?|complete\w*|rewards?|fail\w*|rumou?rs?)\b/i,
    tools: ['quest_dialogue', 'create_quest', 'set_stage', 'remove_stage', 'set_objective', 'connect_stages', 'set_stage_script', 'read_stage_script', 'add_dialogue', 'set_starts_with_game', 'write_journal', 'check_quest', 'list_dialogue_lines', 'edit_dialogue_line', 'edit_player_line', 'remove_dialogue'],
  },
  plans: {
    about: 'planning a whole quest from a description, or reworking one through a plan',
    words: /\b(plan\w*|ideas?|story|questline|rework|rewrite the quest|from (my|this) (text|writing|idea|description))\b/i,
    tools: ['plan_quest', 'revise_plan', 'show_plan', 'edit_plan', 'build_plan', 'quest_as_plan', 'update_quest_from_plan'],
  },
  characters: {
    about: 'new characters, changing characters, routines',
    words: /\b(characters?|npcs?|person|people|m[ae]n|wom[ae]n|followers?|merchants?|blacksmiths?|smiths?|guards?|bandits?|innkeepers?|bards?|wears?|outfits?|routines?|sleeps?|faces?|hair|race|voice|marr\w+|trainers?)\b/i,
    tools: ['create_character', 'change_character', 'character_routine'],
  },
  items: {
    about: 'new or changed items, weapons, armor, spells, perks, lists and other records',
    words: /\b(items?|weapons?|armou?r|swords?|axes?|bows?|daggers?|maces?|shields?|potions?|food|drinks?|spells?|perks?|books?|notes?|rings?|amulets?|necklaces?|enchant\w*|records?|cop(y|ies)|leveled|damage|value|weight|price|gold|keys?)\b/i,
    tools: ['items_and_magic', 'create_record', 'copy_record', 'update_record', 'delete_record'],
  },
  scripts: {
    about: 'Papyrus scripts: read, check, write, compile, attach, properties',
    words: /\b(scripts?|papyrus|compil\w*|propert(y|ies)|functions?|events?|\.psc|bugs?)\b/i,
    tools: ['list_scripts', 'read_script', 'check_script', 'write_script', 'compile_scripts', 'attach_script', 'set_script_property', 'autofill_properties'],
  },
  places: {
    about: 'new interiors, placing, moving and removing objects, clutter, lighting, doors, navmesh',
    words: /\b(put|place\w*|tables?|shelf|shelves|floors?|rooms?|cells?|interiors?|inns?|houses?|homes?|moves?|turn|remove|delete|lights?|lighting|dark\w*|moods?|doors?|navmesh|clutter|dress|decorat\w*|furniture|build|cave|dungeon|tavern)\b/i,
    tools: ['create_place', 'place_object', 'move_objects', 'remove_objects', 'dress_room', 'light_room', 'add_linked_door', 'link_doors', 'make_navmesh', 'drop_to_floor'],
  },
  triggers: {
    about: 'something happening when the player uses, opens, picks up, reads, equips or hits an object, or arrives somewhere',
    words: /\b(when (the )?player|triggers?|activat\w*|opens?|pulls?|levers?|pick(s|ed)? up|picks|reads?|equips?|hits?|dies|kill\w*|arrives?|buttons?|chests?|traps?|secret)\b/i,
    tools: ['list_triggers', 'add_trigger', 'change_trigger', 'remove_trigger'],
  },
  outdoors: {
    about: 'outdoor cells, worldspaces, shaping and painting the ground',
    words: /\b(hills?|ground|terrain|land|outdoors?|outside|exteriors?|worldspaces?|roads?|paths?|flat\w*|valleys?|ridges?|paint\w*|grass|dirt|snow|rocks?|mountains?|slopes?)\b/i,
    tools: ['list_worldspaces', 'ground_info', 'list_ground_textures', 'create_worldspace', 'create_outdoor_cell', 'shape_ground', 'paint_ground', 'drop_to_floor'],
  },
  checks: {
    about: 'checking the mod: release check, conflicts, quest problems, what uses a record',
    words: /\b(checks?|problems?|bugs?|errors?|release|conflicts?|review|fix\w*|broken|wrong|used|uses|where is|who uses|refer\w*)\b/i,
    tools: ['release_check', 'review_mod', 'conflict_report', 'check_quest', 'check_script', 'who_uses', 'load_order'],
  },
  project: {
    about: "a bigger job's brief and to-do list",
    words: /\b(projects?|to-?do|tasks?|questline|town|village|whole mod|bigger|go on|continue|next)\b/i,
    tools: ['set_project', 'update_task', 'add_tasks', 'update_brief'],
  },
};

/** The tools to show a free AI for this message, and the rest by topic. */
export function offerTools(all: AgentTool[], session: AgentSession, text: string, context?: string): ToolOffer {
  const byName = new Map(all.map((t) => [t.name, t]));
  const pick = (names: string[]) => names.map((n) => byName.get(n)).filter((t): t is AgentTool => !!t);
  const topics = new Set<string>();
  const match = (s: string) => {
    for (const [k, t] of Object.entries(TOOL_TOPICS)) if (t.words.test(s)) topics.add(k);
  };
  match(text);
  if (context) match(context);
  // Follow-ups ("yes, do it", "go on") keep the topics the conversation has been about.
  const used = new Set(session.messages.flatMap((m) => (m.role === 'assistant' ? m.calls.map((c) => c.name) : [])));
  for (const [k, t] of Object.entries(TOOL_TOPICS)) if (t.tools.some((n) => used.has(n))) topics.add(k);
  if (!topics.size) for (const m of session.messages.slice(-6)) if (m.role === 'user') match(m.text);
  if (session.project) topics.add('project');
  // Nothing to go on: the reading and checking tools, to look around and answer.
  if (!topics.size) topics.add('checks');
  const shown = new Set([...ALWAYS, ...[...topics].flatMap((k) => TOOL_TOPICS[k]!.tools)]);
  return {
    tools: all.filter((t) => shown.has(t.name)),
    topics: Object.fromEntries(
      Object.entries(TOOL_TOPICS)
        .filter(([k]) => !topics.has(k))
        .map(([k, t]) => [k, { about: t.about, tools: pick(t.tools) }]),
    ),
  };
}
