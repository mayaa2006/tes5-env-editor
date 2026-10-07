# Changelog

Each version here is published as a Windows installer and portable exe on the [releases page](https://github.com/mayaa2006/tes5-env-editor/releases).

## 0.2.0

- **Spells, perks and more get proper forms:**
  - **Magic:** magic effects, spells, enchantments, scrolls, shouts, words of power and leveled spells.
  - **Perks:** quest-stage, ability and entry-point effects, with their conditions and values.
  - **Items and crafting:** potions and food (with their effects), ingredients, leveled items, crafting and tempering recipes, apparatus, and the full weapon, ammunition and soul gem data.
- **New from scratch:** pick a type in World → Objects and click **New**. The record gets game-like defaults, and its main list (effects, entries, components) is ready to fill.
- **Help on fields:** form fields that need explaining now have a (?).
- **Checked against the official masters:** every record of every type with a form in Skyrim.esm, Update.esm and the three DLC masters reads and writes back byte for byte. This includes 19 quests and 331 cells that could only be edited as raw fields before.
- **New command:** `tes5 records-check` runs the same check on any plugin.
- **Faster:** the first **New** or **Duplicate** after loading the full game takes under a second instead of about 7.
- **Fix:** empty descriptions in the official masters showed as "localized string #0" and couldn't be edited. They now show as empty text you can fill in.

## 0.1.0

The first downloadable build.

- **World:** 3D editing with Blender-style controls, and world tools: paint, paths, drop-to-ground, arrays, kit snapping, lighting, clutter, room builder, linked doors.
- **Navmesh:** one-click generation, plus hand editing.
- **Characters:** RaceMenu-style creator with sliders beyond the game's limits, extra morphs and tint painting. Face files are generated without the Creation Kit and were checked against the CK's own output for about 150 vanilla characters.
- **Quests:** the quest map, quests planned by Claude from a design document or conversation, updating a quest from a revised plan, and the journal and objective writer.
- **Dialogue:** graph and script editors, greetings, chatter and scenes, gestures, and dialogue checks.
- **Behaviour and scripts:** routines (AI packages), triggers, and the Papyrus editor with compiling.
- **Testing and release:** test in game, plugin cleaning, record forms and conflicts, Mod Organizer 2 support, and a Release tab with pre-release checks and BSA/ZIP packing.
