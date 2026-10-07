# Changelog

Each version here is published as a Windows installer and portable exe on the [releases page](https://github.com/mayaa2006/tes5-env-editor/releases).

## 0.5.0

- **Body tab (BodySlide):** shape bodies with the sliders and presets mods already ship for BodySlide.
  - Finds slider sets and presets in your Data and mod folders (`CalienteTools\BodySlide`); **Rescan** looks again.
  - Sliders can have one value, or a different one at weight 0 and weight 100. A **preview weight** slider shows the blend, and the 3D view turns.
  - **Build body** writes the `_0` and `_1` meshes into your mod, as BodySlide does. **Save preset** writes a preset BodySlide can use too. Each is one undo step.
  - Not checked against real body mods yet; see the ROADMAP.

## 0.4.0

- **Outdoors:** an outdoor cell now opens with its neighbours, so you see the surrounding landscape and everything on it.
  - **W / N / S / E** buttons in the World toolbar step to the next cell.
  - View → **Outdoors, also load** picks how many cells around (0, 1 or 2).
  - Objects dropped into the view go into the cell under them.
  - The outliner lists everything in view, with **Only the current cell** to narrow it.
- **Terrain sculpting:** World tools → **Terrain** has Raise, Lower, Smooth and Flatten brushes.
  - Drag on the ground and see the change live; Ctrl swaps raise and lower.
  - Works across cell borders without seams, and each stroke is one undo step.
  - Objects that stood where you sculpted are listed afterwards, with **Put them on the ground**.
- **Characters look like people:** placed characters show their body, outfit and face instead of a capsule (View → **Characters as people** to turn it off).
- **Faster:** the cell list for a large worldspace loads once instead of on every change.
- **Fix:** the 3D view stayed blank if you picked a cell after opening the World tab.

## 0.3.0

- **Items and Magic tabs:** items, crafting, loot lists, spells, perks and the rest now have their own tabs instead of one long list in World → Objects.
  - Categories are in plain words: Weapons, Potions & food, Crafting recipes, Spells, Powers, Abilities, Perks…
  - Every record in a list shows a one-line summary, like "One-handed sword · 7 damage · 25 gold".
- **Simple editors** for weapons, armor, potions, ingredients, books, loot lists, recipes, spells, magic effects, enchantments, shouts and perks.
  - Labels are plain, and every field has a (?) explaining it.
  - Effects show as cards with a sentence ("Fire Damage, strength 25, for 1 s").
  - Perk effects read like "Mod Attack Damage: multiply by 1.2".
  - **Show every field** still gives the full form.
- **New records start with useful values:** a new power is a greater power cast on yourself, a new ability is always on, a new recipe makes 1.
- **Search finds recipes by what they make:** "iron sword" finds both the forge recipe and the grindstone one.
- **Pickers show names first:** "Restore Health" instead of "AlchRestoreHealth".
- **World → Objects** only lists what you place in the world.
- **Records tab:** records with a simpler editor get an **Open in Items/Magic** button.
- **Fix:** spell tomes now store the spell they teach as a real link, so it stays correct when masters change.

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
