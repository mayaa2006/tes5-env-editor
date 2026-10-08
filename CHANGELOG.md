# Changelog

Each version here is published as a Windows installer and portable exe on the [releases page](https://github.com/mayaa2006/tes5-env-editor/releases).

## 0.12.0

- **Paint the ground:** World tools → **Terrain** → **Paint**. Pick a landscape texture (search it, see its colour), press **Start painting** and drag. Ctrl+drag fades it.
  - Works like the CK: each quarter of a cell keeps its base texture plus up to six painted ones. You're told when a spot is full.
  - The ground picture updates while you paint. Each stroke is one undo step.
- **Under the hood:** landscape textures (LTEX: texture set, material, friction, specular, grass) are fully readable and editable. Every vanilla one writes back unchanged.
- The demo has three ground textures to try (grass, rock, dirt).

## 0.11.0

- **The quest plan is in tabs:** **Overview**, **Cast & places**, **Story**, **World events** and **Dialogue**, instead of one long page.
  - Each tab shows how much is in it.
  - Overview lists what's in the plan, with links to each tab.
  - Problems that must be fixed show on the tab you're working on.
  - **Ask Claude to change the plan**, **Undo edit** and **Build** stay at the bottom while you scroll.
- **README:** the feature list is grouped by area (world, characters, quests and dialogue, items and magic, your mod) with links, instead of one big table.

## 0.10.0

- **Characters who fight:** a quest plan can make a character attack the player on sight, level with the player, and set their skills, spells, perks and fighting style.
- **Enemy groups:** "six bandits in the cave": enemies from your load order are placed in a place, and **When all are dead** moves the quest on. See the new **Enemy groups** card in the plan.
- **Roles:**
  - **Followers** and characters the player can **marry**.
  - **Merchants**, with their own shop faction, opening hours, what they buy and sell, and a chest of stock.
  - **Trainers**: a skill and how far they teach (50, 75 or 90).
  - **Innkeepers.**
  - Switch these on under **Roles and fighting** on each character in the plan.
- **Relationships:** how characters feel about each other and the player (friend, ally, rival, enemy, lover…).
- **Under the hood:** factions (vendor data, ranks, crime settings), classes (what they teach) and relationships are now fully readable and editable. Every vanilla faction, class and relationship reads and writes back unchanged.
- **Fix:** the plan's build report no longer repeats a character's other changes after each routine line.

## 0.9.0

- **Choices the quest remembers:** put `[remember spared]` on a line, and `[if chose spared]` (or `[if not chose spared]`) on later lines that react to it. Claude uses them when your text has choices that matter later.
- **Several endings:** Claude gives each outcome its own completing stage, closing journal entry and rewards.
- **Quests can fail:** if a character dies before the quest is finished, or if it isn't done within some in-game days. Set them in the plan's new **How the quest can fail** card (it adds a failing stage if there isn't one). The quest map shows them as arrows into the failing stage, and **Change with a plan** updates them.
- **Undo edit** in the plan review covers all of these.

## 0.8.0

- **New places come ready to use:** a new place in a quest plan can be laid out like an existing interior (an inn, a house, a cave…). Its walls, furniture, lights and clutter are copied, but not its people or quest objects. Claude picks one that fits; you can change it under **Places** in the plan (**Laid out like**).
- **Doors in:** say where the player walks in from (**Door from**), and a door is put against a wall there and linked both ways with the new place's way out.
- **Navmesh included:** new furnished places get a navmesh, so characters can walk there.
- **Fix:** tools that list cells now see a cell made earlier in the same step (the new place's navmesh needed it).

## 0.7.0

- **Quests can start when something happens:** a quest plan can now start the quest when the player enters a place, reads a note, picks something up or uses something, instead of from the start of the game. Claude picks this from your text ("when the player finds the letter…"). Check and change it in the plan's **How the quest starts** card.
- **Questlines:** a quest can start when another of your quests reaches a stage (its end, unless you pick one), so part two follows part one. Claude sees the quests already in your plugin.
- **The quest map shows what starts the quest**, next to **Running from game start**.

## 0.6.0

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
