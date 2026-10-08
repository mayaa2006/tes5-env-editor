# TES5 Env Editor

An automation-first alternative to the Skyrim Creation Kit for quests, characters, environments and scripting, with SSEEdit-style plugin cleaning built in.

The editor reads and writes Skyrim LE/SE plugins (`.esm`/`.esp`/`.esl`) itself. It does not drive the Creation Kit.

> **Status: early.** The core works end to end on the bundled demo data set, with automated tests for each part. It has **not** been tested against a full Skyrim.esm load order. See [ROADMAP.md](ROADMAP.md) for what's done, what's partial and what's missing.

## Download

Get the Windows app from the [latest release](https://github.com/mayaa2006/tes5-env-editor/releases/latest):

- **TES5-Env-Editor-x.y.z-Setup.exe** installs it, with Start menu and desktop shortcuts.
- **TES5-Env-Editor-x.y.z-Portable.exe** runs without installing.

The exe isn't code-signed yet, so Windows SmartScreen may say "Windows protected your PC". Choose **More info → Run anyway**. Each release's notes list what changed (also in [CHANGELOG.md](CHANGELOG.md)).

## What it does

[The world](#the-world) · [Characters](#characters) · [Quests and dialogue](#quests-and-dialogue) · [Items, magic and scripts](#items-magic-and-scripts) · [Your mod](#your-mod-records-cleaning-and-release) · [Finding your way](#finding-your-way)

### The world

#### World

Three.js viewport with Blender controls:

- **Navigation:** MMB / Alt+LMB orbit, Shift pan, wheel zoom, RMB + WASD fly, numpad views, F / Home to frame.
- **Transforms:** G/R/S with X/Y/Z axis constraints, typed values and Ctrl snapping. Also a gizmo and a snap toggle.
- **Editing:** Shift+D duplicate, X delete (master references are disabled safely, never deleted), H/Alt+H hide.
- **Drag and drop:** drag base objects or raw `.nif` files from the browser into the scene. A Static base record is created for meshes automatically, with bounds.
- **Scene:** outliner, LAND terrain with its real ground textures, cell lighting preview.
- **Outdoors:** an outdoor cell opens with its neighbours around it (View → **Outdoors, also load**: 0, 1 or 2 cells around), and the **W / N / S / E** buttons step to the next cell. Objects you drop land in the cell under them. The outliner lists everything in view, or **only the current cell**.
- **New cells and worldspaces:** the Cells list has **New** (indoors), **New worldspace** and **+ Cell** on each worldspace. A new worldspace starts as a square of flat ground (1×1 up to 7×7 cells) with its persistent cell, an optional ground texture, water, and weather and music taken from another worldspace (Tamriel by default). Outdoors, a dashed **W+ / N+ / S+ / E+** button means there's no cell that way yet: click it to make one and go there. New ground meets the cells around it and uses their ground texture. Each is one undo step.
- **Characters as people:** placed characters show with their body, outfit and head (their face file, or the race's head), with their skin tone and hair colour, instead of a capsule (shown until all their textures have loaded), following templates and leveled lists like the game. Turn it off under View.

#### Terrain sculpting and ground painting

World tools → **Terrain**: **Raise**, **Lower**, **Smooth** and **Flatten** brushes with a brush size and strength. Drag on the ground to sculpt (Ctrl swaps raise and lower); you see the change live, across cell borders without seams. Each stroke is one undo step. Afterwards, objects that stood where you sculpted are listed with **Put them on the ground**.

**Paint** paints ground textures, like the CK's landscape painting. Pick a texture from the list (search by name, each has a colour swatch), press **Start painting** and drag on the ground; Ctrl+drag fades the texture away. The picture updates as you paint, across cell borders. Each quarter of a cell holds its base texture plus up to six painted ones, as in the game; you are told when a spot is full. Each stroke is one undo step.

#### World tools

A tools panel in the World view:

- **Paint:** a brush that scatters a weighted palette (plants, rocks, clutter) with spacing, random size and turn, slope limits and tilt-to-slope; Ctrl+drag erases. Each stroke is one undo step.
- **Paths:** click a line and pieces are laid end to end along it (roads, fences on both sides, rows of lamp posts), following and tilting with the ground.
- **Place:** drop objects onto whatever is below them, and arrays (copies with a step and turn).
- **Kit snapping (on by default):** while moving with G, wall and floor pieces snap flush to their neighbours. Toggle it with the **Kit** button (or View → Snapping settings); hold Alt to skip it for one move.
- **Lighting:** adds a light above every candle, torch, brazier and fire that has none, and applies mood presets (tavern, crypt, cave, ice cave…) to a cell's ambient, light and fog colours.
- **Clutter:** dresses a room by theme (tavern, home, storeroom, study, alchemy, smithy) with items on table tops and bigger things along the walls, using what's in your load order.
- **Room builder:** paint a floor plan and pick kit pieces; floors, walls, corners and doorways are placed, then the navmesh is generated.
- **Doors:** link two load doors, or create the matching door in another cell. The arrival points go on the open side of each door, and they follow when a door is moved.
- A warning appears when a cell's navmesh is older than the objects in it.

#### Navmesh

One-click generation from cell geometry and terrain (Recast). Doors are linked automatically and exterior cells are stitched to their neighbours. Tab enters an edit mode where you can draw triangles (snapping to existing vertices), move vertices with G, delete triangles, and set the preferred / water / no-large-creatures flags.

### Characters

#### Characters

A RaceMenu-style creator with a live 3D preview:

- race, sex, weight and height; head parts filtered to the race and sex;
- **Face:** pick a feature (head, nose, eyes, brows, cheeks, mouth, jaw, chin, ears) and use the game's own sliders for it plus **shape sliders the game doesn't have**: size, width, height, depth, up/down, forward/back, and for paired features apart/together and tilt. **More shapes** lists every extra morph the head parts' .tri files carry (like RaceMenu morph packs). **Beyond game limits** lets any slider go up to 3× further. Randomize, reset per feature, and undo for everything;
- **Paint:** the race's tint masks by name (Skin Tone, Lips, Warpaint 01…), each with a colour and strength, and a preview of the baked face tint;
- hair colour, skin tone and face texture.

**Face files without the Creation Kit:** the head mesh (every slider, shape and morph baked in, merged the way the CK's Ctrl+F4 does) and the face tint are generated into your mod's Data folder: from the character's page, from the Release tab, or automatically on save. The extra shaping is baked into those files, so it shows in game without SKSE or RaceMenu. The output was checked against the Creation Kit's own face files for about 150 vanilla characters: same layout and settings, and shapes within about 3 mm (see the ROADMAP).

#### Routines

What characters do with their day, in plain words: **go about their business** (sit, chat, work), **sleep**, **eat**, **stay put** or **travel**, in a place or around where they stand, at chosen hours. Each one is an AI package made from the game's own template (Sandbox, Sleep, Eat, Travel). It's on the Characters tab's **Routine** page and in quest plans. Quest plans can also make someone **follow the player** or **walk up and speak** (forcegreet) during some stages; that behaviour goes on the quest alias, so it ends with the quest.

#### Body (BodySlide)

The Body tab reads the BodySlide files mods ship (`CalienteTools\BodySlide`) and does what BodySlide does, without leaving the editor:

- **Sets and presets:** every slider set found in your Data and mod folders, and the presets made for it.
- **Sliders:** one value, or a different one at weight 0 and weight 100 (the game blends the two). Values can go past 0–100% if you allow it.
- **Live 3D preview** that turns, with a preview-weight slider.
- **Build body** writes `<name>_0.nif` and `<name>_1.nif` into your mod (the same two meshes BodySlide makes); **Save preset** writes a preset BodySlide itself can load. Both are one undo step.

### Quests and dialogue

#### Quests

Quests are built on a **quest map**: stages are boxes, and you drag a connection between them saying what moves the quest on (talk to someone, pick up / use / drop an item, kill someone, arrive at a place, equip, read, or a script). The editor writes the dialogue, alias triggers or stage scripts that make each connection happen, and reads them back as arrows. The map also covers:

- journal text, objectives shown/completed per stage, and the cast (aliases);
- a problems list (unreachable stages, no ending, dialogue that can't start).

Other tabs keep the stage list, objectives, aliases and voice-file names.

The quest list on the left shows only quests that have a name by default (the hidden internal ones are left out); untick **Only quests with names** to see every quest.

#### Quest from writing

**Quests → From text:** paste a design document, or just a conversation with no tags, and Claude plans the whole quest:

- who's in it (characters from your load order, or new ones copied from a similar character), where, and which items;
- stages with journal entries, objectives with quest markers, what moves the quest on, the dialogue, and the rewards;
- **characters as described, new or existing:** what they wear (saved as an outfit if you ask), what they carry, factions, class, level, whether they can die, and their look (build, height, hair, hair colour, beard, eyes, scars), matched loosely to your load order ("fine blue clothes" finds Fine Clothes). New characters can be "like" an existing one. You can also describe only character changes, with no quest.
- **fighting:** characters who attack the player on sight, level with the player, and have the skills, spells, perks and fighting style the text describes. **Enemy groups** take enemies from your load order ("six bandits in the cave") and put them in a place, and the quest can move on once they're all dead.
- **roles:** followers, characters you can marry, merchants (with their own shop faction, opening hours, buy-and-sell list and a chest of stock), trainers (a skill and how far they teach) and innkeepers, plus how characters feel about each other and the player (friend, ally, rival, enemy, lover). Switch them on under **Roles and fighting** for each character in the plan.
- **what happens at each stage:** enemies appear ("three bandits ambush you"), someone turns hostile or calms down, a door or chest unlocks or locks, something appears or vanishes (it starts hidden), someone moves or dies, the screen fades to black and back (with moves happening in the dark), a sound or a weather change, a message, another quest starts, or the player is moved. Check and change them on the plan's **World events** tab.
- **choices, endings and failure:** several endings, each with its own closing journal entry and rewards, decided by what the player chooses. Choices the quest remembers (`[remember spared]` on a line, then `[if chose spared]` on later lines). The quest can fail if a character dies before it's finished, or if it isn't done within some in-game days (**How the quest can fail** in the plan). The quest map shows both as arrows into the failing stage.
- **new places come ready:** a new interior is laid out like an existing one you (or Claude) pick, such as an inn, a house or a cave, with its walls, furniture, lights and clutter copied. A linked door is put against a wall in the place the player walks in from, and the new place gets a navmesh. Change both under **Places** in the plan.
- **how it starts:** with the game (for quests that begin by talking to someone), or when the player enters a place, reads a note, picks something up or uses something, or **after another of your quests** reaches a stage, so a questline's parts follow each other. The quest map shows what starts each quest.
- **where things go:** characters stand on real floor at the level you walk in on, clear of walls and each other, or at a named spot ("behind the bar", "by the forge") facing it; items go on tables or named furniture, or **inside a named container** ("in the chest"). That chest gets its own copy of the container, and the quest creates the item inside it, so picking it up still counts and the marker points at it.

You check the plan first, in tabs: **Overview** (problems to fix and every decision Claude made on its own), **Cast & places**, **Story** (how it starts, stages and journal, objectives, what moves it on, how it can fail), **World events** and **Dialogue**. Problems that must be fixed show on whichever tab you're on, and the Build button stays at the bottom. You can edit the journal, objectives and dialogue directly, or ask Claude to change something ("make Eirik the thief"). **Build the quest** then creates everything (records, triggers, scripts, dialogue) as one undo step, and lists what still needs you (such as empty new interiors); new and changed faces get their face files when you save. Uses your own Anthropic API key; **Use the example** tries it without one.

**Change with a plan** (on any quest) shows the quest as a plan: exactly as it was built, or read back from a quest made by hand. Change it yourself or ask Claude ("add a stage where Eirik confesses"), see the list of what will change, and **Update the quest**. Only those differences are applied (stages, journal, objectives, steps, characters, routines, rewards, events, how it starts, how it fails, and conversations that came from the plan), so edits you made by hand stay. One undo reverts the update.

#### Dialogue

Branching dialogue as a graph: drag from a response to a player line to offer it as a choice, or into empty space to write a new one. **Write as script** edits a whole conversation as a screenplay (`NAME: line`, indentation for choices, `[goodbye]`, `[stage 20]`, `[if stage 10]`, `[emotion happy]`, `[gives gold x100]`, `[takes Ring x1]`, `[gesture wave]`, `[once]`, `[persuade 50]`), with conditions in plain words (`[if has Ring]`, `[if done 20]`, `[if gold 100]`, `[if speech 50]`, `[if level 10]`, `[if female]`, `[if race Nord]`, `[if quest MyQuest done]`, `[if chose spared]`), choices the quest remembers (`[remember spared]`, `[forget spared]`). Blocks for lines nobody prompts: `GREETING:` (said as the player comes up), `IDLE:` (chatter) and `SCENE: name [at stage 20]` (characters talking to each other, played in order), and topics, responses, conditions, choices and stage fragments are created from it. The list view keeps the condition and begin/end-script editors.

#### Gestures

Characters can wave, point, bow, laugh, applaud, pray and more, chosen by everyday name:

- **in dialogue:** a gesture picker on each response (or `[gesture wave]` in a script) plays it as the line starts;
- **at quest events:** in a stage's panel on the quest map, choose who plays which animation when the quest reaches that stage.

The game's own idle form is used when it's in your load order (so its conditions apply); otherwise the animation event is sent directly. Idles from other mods are listed too.

#### Dialogue check

The Dialogue tab's **check** button (and the script editor, as you type) finds:

- lines nobody answers, and choices that can never be reached;
- "goodbye" before choices;
- lines that can still be chosen after they moved the quest on;
- stages that don't exist, mistyped tags (which would silently lose a stage change), and lines too long for the menu or a subtitle;
- placeholders like TODO.

The same checks run in the Release tab and on a quest plan before it's built.

#### Journal & objectives

**Write journal** on the quest map drafts the missing journal entries and objectives from the arrows ("I spoke with Brynja. I should find her ring." / "Find Brynja's Ring"). You can edit or untick any of them, let Claude word them in the game's style, then apply them in one step. It also flags wording problems, such as a journal written to "you", objectives with a full stop, or objectives too long for the screen. The same writer is in the plan review (**Draft missing journal** / **Word with Claude**).

#### Triggers

"When / If / Do" blocks for placed objects and quest aliases, instead of writing a script: e.g. *when the player activates this, if stage 10 is done, move them to the door and show a message*. The Papyrus is generated, attached and kept in sync, and you can view it. Ready-made templates cover the common jobs (unlock when a quest reaches a stage, advance a quest when picked up or killed, teleport, reveal hidden objects, message on arrival, …).

#### Test in game

One click saves and writes a batch file. In game you type `bat tes5test` and it takes you to the chosen cell, replays the quest stages up to the one you picked (following the quest map), gives the items you listed and optionally turns on god mode. In the desktop app it can also start the game via SKSE or through Mod Organizer 2.

### Items, magic and scripts

#### Items

Its own tab, sorted the way players think of things: weapons, armor & clothing, potions & food, ingredients, books, scrolls, arrows, keys, soul gems, misc items, alchemy tools, loot lists, crafting recipes and outfits. Each list shows a one-line summary ("One-handed sword · 7 damage · 25 gold", "Makes Iron Sword · at Forge · 2 components"), and search also matches what a recipe makes. The editors show what matters in plain words:

- **weapons and armor:** damage, speed, reach, skill, armor rating, body slots, enchantment, keywords;
- **potions and ingredients:** potion, food or poison, automatic value, and their effects;
- **loot lists:** a table of level, item and count, a chance-of-nothing slider, and the pick rules in words;
- **recipes:** what it makes, how many, at which station (Forge, Grindstone, Tanning rack…), what it uses, and when it shows;
- **books:** the text, and the skill or spell it teaches.

**New** makes one with sensible starting values, and **Show every field** gives the full CK-style form.

#### Magic

Its own tab: spells, powers, abilities, diseases, magic effects, enchantments, shouts, words of power, perks and leveled spells.

- **Spells:** kind, casting, target, hands, automatic or set cost, description, and effects as cards ("Fire Damage, strength 25, for 1 s") with their conditions.
- **Magic effects:** what it does, which value it changes, school, resistance, spell level, and the flags in words ("Hostile", "Wears off").
- **Perks:** whether the player can take it, the next rank, requirements, and effects in sentences ("Mod Attack Damage: multiply by 1.2"), with the condition tabs the game expects for each entry point.
- **Enchantments, shouts, words:** used on weapon / worn item / staff; three words with spell and cooldown; word and meaning.

A new power starts as a greater power cast on yourself, a new ability as always-on, and so on.

#### Scripts

Monaco editor for Papyrus with live errors, completion, hover, signature help and an outline. Compiling uses PapyrusCompiler.exe or Caprica, with clickable errors.

### Your mod: records, cleaning and release

#### Records

Every record type, with an xEdit-style conflict view comparing each plugin's version. Records with a simpler editor have an **Open in Items/Magic** button. Every form was checked against the five official masters: all 1.16 million of their records of the typed types read and write back byte for byte (`tes5 records-check`).

#### Cleaning

Quick-Auto-Clean equivalent:

- removes identical-to-master records (ITMs), with a "safe" mode that keeps deliberate reverts;
- undeletes and disables deleted references (UDRs);
- can optionally restore deleted navmeshes.

Analyze shows what would change before you clean. Also available from the CLI.

#### Automations

- **On every save (your choice):** remove identical-to-master records, recalculate object bounds, write SEQ files, generate face files for characters whose look changed.
- **Always:** masters added and sorted, parent records copied, counts and dialogue order kept right, alias IDs, fragment scripts and their properties, safe deletes, backups, strings files, undo for everything.

The tab also points to the automation tools in the other tabs.

#### Release

A final tab before sharing your mod:

- **Pre-release check:** finds missing meshes and textures, uncompiled scripts, empty script properties, aliases that can't fill, unvoiced lines, characters without a voice, characters whose face files are missing or out of date (fixed with one click), floating or sunk items, one-way doors, missing or out-of-date navmeshes, wrong bounds and dirty edits. Each result links to the problem, and many have a one-click fix.
- **Character faces (FaceGen export):** every character in your plugin with the state of its face files (up to date, out of date, missing, uses its template). **Generate faces** makes all the changed ones; tick any others and **Export ticked** to write them again, like the CK's Ctrl+F4. Tints are written like the CK's (BC3 with mipmaps). Characters that take their looks from a template are recognised and need no files.
- **Light plugin (ESL)** check.
- The check updates by itself after each change.
- **Conflicts:** which of your records other mods also change, and whose version the game uses.
- **Pack into a BSA** (your plugin's own files, named so the game loads it) or **Pack as a ZIP** (plugin plus files, optionally in a BSA, ready to upload).

#### Mod Organizer 2

Opens an MO2 instance and profile directly, using its virtual Data folder (loose files override BSAs). Saves go to Overwrite.

### Finding your way

#### Easy to find your way

- One-row toolbars, with camera and display options under **View** and navmesh actions under **Navmesh**.
- The Outliner and World tools share a panel beside the 3D view.
- Press **?** for every keyboard and mouse shortcut.
- A **(?)** next to settings and options explains what each one does.
- Settings live where they're used: compiler under Scripts → Compiler, snapping under View → Snapping settings.
- The properties panel (every field of the selected form) can be hidden from the top bar. It starts hidden in the Characters and Quests designers, so they get the full width.
- Side panels shrink on smaller windows, and the World toolbar drops its words (keeping icons and tooltips) when the 3D view gets narrow.
- **Start screen:** finds Skyrim in your Steam libraries and GOG folders, so you usually just click **Open**. The plugin list has search and **All / Only masters / None**, and unticking a master unticks the plugins that need it.
- **Empty screens say what to do next**, with a button for it (New character, New quest, Describe a quest, New script).
- Character and quest lists can show **only the ones in your plugin**, and say when there are more than they show.
- Conditions show names, not numbers: skills and stats ("One-handed", "Health"), crime types, hands, alignment.
- Records lists name placed objects after what they place ("Barrel (placed)").
- Escape closes any dialog, even while typing.

## Running it

Requires Node 22+.

```bash
npm install
npm run dev:web     # browser demo on http://localhost:5173 (in-memory demo data, nothing touches your game)
npm run dev         # desktop app (Electron) with real file access
npm run build       # production build (web bundle + Electron main/worker)
npm run dist -w @tes5/studio   # Windows installer + portable exe in apps/studio/release
```

When you start the desktop app you can open either:

- your Skyrim folder, or
- a Mod Organizer 2 instance folder.

Then choose the plugins to load and the plugin your changes go into. To compile scripts, set the path to `PapyrusCompiler.exe` in **Automations → Papyrus compiler**.

### Command line

```bash
npm run cli -- info  MyMod.esp
npm run cli -- clean MyMod.esp --data "C:/Games/Skyrim Special Edition/Data" --dry-run
npm run cli -- clean MyMod.esp --data ... --mode xedit       # writes a .backup first
npm run cli -- esl   MyMod.esp --data ...
npm run cli -- bsa list|extract|pack ...
npm run cli -- nif  some.nif
npm run cli -- face-compare Skyrim.esm --data "C:/Games/Skyrim Special Edition/Data" --npc Ysolda   # generated vs the CK's FaceGen
npm run cli -- face-kit MyMod.esp --data ... --npc MyNpc      # zip just what comparing those faces needs
npm run cli -- records-check Skyrim.esm MyMod.esp --type SPEL,PERK   # do the forms read and write these records exactly?
```

### Checks

```bash
npm run typecheck   # all packages + the Studio app
npm test            # unit tests (vitest)
npm run test:e2e    # Playwright end-to-end test of the browser demo
npm run bench       # performance at Skyrim.esm scale (synthetic ~900k-record master)
```

## Layout

- `packages/esp`: plugin format, record schemas, conditions, VMAD, navmesh codec
- `packages/cleaner`: ITM/UDR cleaning
- `packages/papyrus`: Papyrus parser, checker, language service, fragment scripts, compiler driver
- `packages/assets`: BSA (zlib/LZ4), NIF geometry and block-level editing (FaceGen head merging, body shaping), DDS, FaceGen TRI, BodySlide morph data (.osd/.bsd)
- `packages/navmesh`: navmesh generation (Recast), linking, validation
- `packages/workspace`: the editing engine (load order, MO2, virtual file system, edits/undo, services, automations, demo data)
- `packages/cli`: the `tes5` command-line tool
- `apps/studio`: the desktop/web editor (React, three.js, Monaco, Electron)

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit together.

## Disclaimer

This is an independent community tool, not affiliated with or endorsed by Bethesda. Keep backups of your plugins; the editor writes a backup before overwriting any file, but it is young software.
