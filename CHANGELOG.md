# Changelog

Each version here is published as a Windows installer and portable exe on the [releases page](https://github.com/mayaa2006/tes5-env-editor/releases).

## 0.5.0

- **Things happen at quest stages:** a quest plan can now make enemies appear, turn someone hostile or friendly, unlock or lock a door or chest, make something appear or vanish, move or kill a character, fade to black, play a sound, change the weather, show a message, start another quest or move the player when a stage is reached. Claude adds them from your text ("bandits ambush you", "the door unlocks"); check and change them in the plan's **What happens at stages** card. **Change with a plan** updates them too.
- **Undo in the plan review:** **Undo edit** takes back your last edit to a plan before you build it.
- **Face files (FaceGen export) like the CK's Ctrl+F4, as a list:** Release → Character faces lists every character in your plugin and whether its face files are up to date, out of date or missing.
  - **Generate faces** makes every changed one; tick any others and **Export ticked** to write them again.
  - Face tints are now written like the Creation Kit's: compressed (BC3) with mipmaps, about a third of the size.
  - Characters that take their looks from a template no longer show as needing face files (the game uses the template's face). Their page says so and opens the template.
  - A character whose files are up to date has **Write again**.
- **Easier to find Skyrim:** the start screen finds it in your Steam libraries and GOG folders, so you usually just click **Open**.
- **Plugin list:** search, **All / Only masters / None**, and unticking a master unticks the plugins that need it.
- **Empty screens say what to do next**, with a button for it, on the Characters, Quests, Scripts and Records tabs.
- **Only mine:** the Characters and Quests lists can show only what your plugin adds or changes, and say when there are more than they show.
- **Conditions show names:** skills and stats ("One-handed", "Health"), crime types, hands and alignment are picked from a list instead of typed as numbers.
- **Records** names placed objects after what they place.
- **World toolbar** stays on one row on small windows (icons with tooltips).
- **The ground looks like the game's:** outdoor terrain now shows its real textures (dirt, grass, rock, snow), blended the way the game paints them, instead of a flat green.
- **Characters show their whole body** on the character creator's Body page: body, clothes and armor, not just the head.
- **Clothes and armor use their real textures and shading** (they were a flat colour): skinned meshes now take their texture coordinates and normals from the right place in the mesh file. Bare skin (neck, arms, hands) uses the character's skin tone the way the game does, so it matches the face.
- **No more neck seam:** bodies and armor are blended between their thin and heavy versions by the character's weight, as in game, so the neck meets the head.
- **Normal maps and shine:** surfaces now show their bumps, folds and fur from their normal maps, and shine where the game's specular mask says; skin uses its model-space normal map, which also hides the head–body join.
- **Heads sit right on their necks in the World view:** FaceGen face files keep some bones in another pose; the head is now placed by the bone that moves most of it.
- **World view characters** get the same: weight-blended bodies, their own skin tone, and their face tint.
- **No more white blobs:** the boxes that mist, smoke and other effects carry for the editor are hidden; glows, webs and splashes use their own colour and blending; water is blue. Marker shapes inside furniture and dragon perches are hidden unless View → **Marker shapes on furniture** is on.
- **Fixes:** the pre-release check no longer shows problems you've already fixed (it updates itself); Escape now closes dialogs while you're typing in them; armor lying in the world (on racks and tables) now shows its ground model instead of nothing.

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
