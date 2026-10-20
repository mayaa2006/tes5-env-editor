/** Skills as people write them ("Archery", "one-handed", "Speech") and as the game names them (Marksman, OneHanded, Speechcraft). */
import { SKILLS } from '@tes5/esp';

/** Skill names as people write them → index in the game's skill list (-1 for none). */
export function skillIndex(name: string): number {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  const alias: Record<string, string> = { archery: 'marksman', bow: 'marksman', speech: 'speechcraft', onehand: 'onehanded', twohand: 'twohanded', lockpick: 'lockpicking', pickpocketing: 'pickpocket' };
  const want = alias[n] ?? n;
  return SKILLS.findIndex((s) => s.toLowerCase() === want);
}

/**
 * "Archery", "Archery x2", "Archery levels 2", "Archery 2" (a [skill …] tag's value) → the game's skill name and
 * how many levels; undefined when it isn't a skill.
 */
export function skillTag(value: string): { skill: string; levels: number } | undefined {
  const m = /^(.*?)(?:\s*(?:[x×]|levels?|by|\+)?\s*(\d+)\s*(?:levels?)?)?$/i.exec(value.trim());
  const i = skillIndex(m?.[1] ?? '');
  if (i < 0) return undefined;
  return { skill: SKILLS[i]!, levels: Math.max(1, Math.min(10, m?.[2] ? Number(m[2]) : 1)) };
}
