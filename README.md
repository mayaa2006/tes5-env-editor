# TES5 Env Editor

An automation-first alternative to the Skyrim Creation Kit for quests, characters, environments and scripting, with SSEEdit-style plugin cleaning built in.

The editor reads and writes Skyrim LE/SE plugins (`.esm`/`.esp`/`.esl`) itself. It does not drive the Creation Kit.

> **Status: early.** The core works end to end on the bundled demo data set, with automated tests for each part. It has **not** been tested against a full Skyrim.esm load order. See [ROADMAP.md](ROADMAP.md) for what's done, what's partial and what's missing.

## What it does

| Area | Highlights |
| --- | --- |
| **World** | Three.js viewport with Blender controls:<br>• **Navigation:** MMB / Alt+LMB orbit, Shift pan, wheel zoom, RMB + WASD fly, numpad views, F / Home to frame.<br>• **Transforms:** G/R/S with X/Y/Z axis constraints, typed values and Ctrl snapping. Also a gizmo and a snap toggle.<br>• **Editing:** Shift+D duplicate, X delete (master references are disabled safely, never deleted), H/Alt+H hide.<br>• **Drag and drop:** drag base objects or raw `.nif` files from the browser into the scene. A Static base record is created for meshes automatically, with bounds.<br>• **Scene:** outliner, LAND terrain, cell lighting preview. |
| **World tools** | A tools panel in the World view:<br>• **Paint:** a brush that scatters a weighted palette (plants, rocks, clutter) with spacing, random size and turn, slope limits and tilt-to-slope; Ctrl+drag erases. Each stroke is one undo step.<br>• **Paths:** click a line and pieces are laid end to end along it (roads, fences on both sides, rows of lamp posts), following and tilting with the ground.<br>• **Place:** drop objects onto whatever is below them, and arrays (copies with a step and turn).<br>• **Kit snapping (on by default):** while moving with G, wall and floor pieces snap flush to their neighbours. Toggle it with the **Kit** button (or View → Snapping settings); hold Alt to skip it for one move.<br>• **Lighting:** adds a light above every candle, torch, brazier and fire that has none, and applies mood presets (tavern, crypt, cave, ice cave…) to a cell's ambient, light and fog colours.<br>• **Clutter:** dresses a room by theme (tavern, home, storeroom, study, alchemy, smithy) with items on table tops and bigger things along the walls, using what's in your load order.<br>• **Room builder:** paint a floor plan and pick kit pieces; floors, walls, corners and doorways are placed, then the navmesh is generated.<br>• **Doors:** link two load doors, or create the matching door in another cell. The arrival points go on the open side of each door, and they follow when a door is moved.<br>• A warning appears when a cell's navmesh is older than the objects in it. |
| **Navmesh** | One-click generation from cell geometry and terrain (Recast). Doors are linked automatically and exterior cells are stitched to their neighbours. Tab enters an edit mode where you can draw triangles (snapping to existing vertices), move vertices with G, delete triangles, and set the preferred / water / no-large-creatures flags. |
| **Routines** | What characters do with their day, in plain words: **go about their business** (sit, chat, work), **sleep**, **eat**, **stay put** or **travel**, in a place or around where they stand, at chosen hours. Each one is an AI package made from the game's own template (Sandbox, Sleep, Eat, Travel). It's on the Characters tab's **Routine** page and in quest plans. Quest plans can also make someone **follow the player** or **walk up and speak** (forcegreet) during some stages; that behaviour goes on the quest alias, so it ends with the quest. |
| **Characters** | A RaceMenu-style creator with a live 3D preview:<br>• race, sex, weight and height; head parts filtered to the race and sex;<br>• **Face:** pick a feature (head, nose, eyes, brows, cheeks, mouth, jaw, chin, ears) and use the game's own sliders for it plus **shape sliders the game doesn't have**: size, width, height, depth, up/down, forward/back, and for paired features apart/together and tilt. **More shapes** lists every extra morph the head parts' .tri files carry (like RaceMenu morph packs). **Beyond game limits** lets any slider go up to 3× further. Randomize, reset per feature, and undo for everything;<br>• **Paint:** the race's tint masks by name (Skin Tone, Lips, Warpaint 01…), each with a colour and strength, and a preview of the baked face tint;<br>• hair colour, skin tone and face texture.<br>**Face files without the Creation Kit:** the head mesh (every slider, shape and morph baked in, merged the way the CK's Ctrl+F4 does) and the face tint are generated into your mod's Data folder: from the character's page, from the Release tab, or automatically on save. The extra shaping is baked into those files, so it shows in game without SKSE or RaceMenu. |
| **Quests** | Quests are built on a **quest map**: stages are boxes, and you drag a connection between them saying what moves the quest on (talk to someone, pick up / use / drop an item, kill someone, arrive at a place, equip, read, or a script). The editor writes the dialogue, alias triggers or stage scripts that make each connection happen, and reads them back as arrows. The map also covers:<br>• journal text, objectives shown/completed per stage, and the cast (aliases);<br>• a problems list (unreachable stages, no ending, dialogue that can't start).<br>Other tabs keep the stage list, objectives, aliases and voice-file names. |
| **Quest from writing** | **Quests → From text:** paste a design document, or just a conversation with no tags, and Claude plans the whole quest:<br>• who's in it (characters from your load order, or new ones copied from a similar character), where, and which items;<br>• stages with journal entries, objectives with quest markers, what moves the quest on, the dialogue, and the rewards;<br>• **characters as described, new or existing:** what they wear (saved as an outfit if you ask), what they carry, factions, class, level, whether they can die, and their look (build, height, hair, hair colour, beard, eyes, scars), matched loosely to your load order ("fine blue clothes" finds Fine Clothes). New characters can be "like" an existing one. You can also describe only character changes, with no quest.<br>• **where things go:** characters stand on real floor at the level you walk in on, clear of walls and each other, or at a named spot ("behind the bar", "by the forge") facing it; items go on tables or named furniture, or **inside a named container** ("in the chest"). That chest gets its own copy of the container, and the quest creates the item inside it, so picking it up still counts and the marker points at it.<br>You check the plan first: every decision Claude made on its own is listed, you can edit the journal, objectives and dialogue directly, or ask Claude to change something ("make Eirik the thief"). **Build the quest** then creates everything (records, triggers, scripts, dialogue) as one undo step, and lists what still needs you (such as empty new interiors); new and changed faces get their face files when you save. Uses your own Anthropic API key; **Use the example** tries it without one.<br>**Change with a plan** (on any quest) shows the quest as a plan: exactly as it was built, or read back from a quest made by hand. Change it yourself or ask Claude ("add a stage where Eirik confesses"), see the list of what will change, and **Update the quest**. Only those differences are applied (stages, journal, objectives, steps, characters, routines, rewards, and conversations that came from the plan), so edits you made by hand stay. One undo reverts the update. |
| **Dialogue** | Branching dialogue as a graph: drag from a response to a player line to offer it as a choice, or into empty space to write a new one. **Write as script** edits a whole conversation as a screenplay (`NAME: line`, indentation for choices, `[goodbye]`, `[stage 20]`, `[if stage 10]`, `[emotion happy]`, `[gives gold x100]`, `[takes Ring x1]`, `[gesture wave]`, `[once]`, `[persuade 50]`), with conditions in plain words (`[if has Ring]`, `[if done 20]`, `[if gold 100]`, `[if speech 50]`, `[if level 10]`, `[if female]`, `[if race Nord]`, `[if quest MyQuest done]`). Blocks for lines nobody prompts: `GREETING:` (said as the player comes up), `IDLE:` (chatter) and `SCENE: name [at stage 20]` (characters talking to each other, played in order), and topics, responses, conditions, choices and stage fragments are created from it. The list view keeps the condition and begin/end-script editors. |
| **Gestures** | Characters can wave, point, bow, laugh, applaud, pray and more, chosen by everyday name:<br>• **in dialogue:** a gesture picker on each response (or `[gesture wave]` in a script) plays it as the line starts;<br>• **at quest events:** in a stage's panel on the quest map, choose who plays which animation when the quest reaches that stage.<br>The game's own idle form is used when it's in your load order (so its conditions apply); otherwise the animation event is sent directly. Idles from other mods are listed too. |
| **Dialogue check** | The Dialogue tab's **check** button (and the script editor, as you type) finds:<br>• lines nobody answers, and choices that can never be reached;<br>• "goodbye" before choices;<br>• lines that can still be chosen after they moved the quest on;<br>• stages that don't exist, mistyped tags (which would silently lose a stage change), and lines too long for the menu or a subtitle;<br>• placeholders like TODO.<br>The same checks run in the Release tab and on a quest plan before it's built. |
| **Journal & objectives** | **Write journal** on the quest map drafts the missing journal entries and objectives from the arrows ("I spoke with Brynja. I should find her ring." / "Find Brynja's Ring"). You can edit or untick any of them, let Claude word them in the game's style, then apply them in one step. It also flags wording problems, such as a journal written to "you", objectives with a full stop, or objectives too long for the screen. The same writer is in the plan review (**Draft missing journal** / **Word with Claude**). |
| **Triggers** | "When / If / Do" blocks for placed objects and quest aliases, instead of writing a script: e.g. *when the player activates this, if stage 10 is done, move them to the door and show a message*. The Papyrus is generated, attached and kept in sync, and you can view it. Ready-made templates cover the common jobs (unlock when a quest reaches a stage, advance a quest when picked up or killed, teleport, reveal hidden objects, message on arrival, …). |
| **Test in game** | One click saves and writes a batch file. In game you type `bat tes5test` and it takes you to the chosen cell, replays the quest stages up to the one you picked (following the quest map), gives the items you listed and optionally turns on god mode. In the desktop app it can also start the game via SKSE or through Mod Organizer 2. |
| **Scripts** | Monaco editor for Papyrus with live errors, completion, hover, signature help and an outline. Compiling uses PapyrusCompiler.exe or Caprica, with clickable errors. |
| **Cleaning** | Quick-Auto-Clean equivalent:<br>• removes identical-to-master records (ITMs), with a "safe" mode that keeps deliberate reverts;<br>• undeletes and disables deleted references (UDRs);<br>• can optionally restore deleted navmeshes.<br>Analyze shows what would change before you clean. Also available from the CLI. |
| **Records** | A schema-driven form for every supported record type, plus an xEdit-style conflict view comparing each plugin's version. |
| **Automations** | • **On every save (your choice):** remove identical-to-master records, recalculate object bounds, write SEQ files, generate face files for characters whose look changed.<br>• **Always:** masters added and sorted, parent records copied, counts and dialogue order kept right, alias IDs, fragment scripts and their properties, safe deletes, backups, strings files, undo for everything.<br>The tab also points to the automation tools in the other tabs. |
| **Release** | A final tab before sharing your mod:<br>• **Pre-release check:** finds missing meshes and textures, uncompiled scripts, empty script properties, aliases that can't fill, unvoiced lines, characters without a voice, characters whose face files are missing or out of date (fixed with one click), floating or sunk items, one-way doors, missing or out-of-date navmeshes, wrong bounds and dirty edits. Each result links to the problem, and many have a one-click fix.<br>• **Character faces:** every edited character whose face files are missing or out of date, with **Generate faces**; and the **Light plugin (ESL)** check.<br>• **Conflicts:** which of your records other mods also change, and whose version the game uses.<br>• **Pack into a BSA** (your plugin's own files, named so the game loads it) or **Pack as a ZIP** (plugin plus files, optionally in a BSA, ready to upload). |
| **Easy to find your way** | • One-row toolbars, with camera and display options under **View** and navmesh actions under **Navmesh**.<br>• The Outliner and World tools share a panel beside the 3D view.<br>• Press **?** for every keyboard and mouse shortcut.<br>• A **(?)** next to settings and options explains what each one does.<br>• Settings live where they're used: compiler under Scripts → Compiler, snapping under View → Snapping settings.<br>• The properties panel (every field of the selected form) can be hidden from the top bar. It starts hidden in the Characters and Quests designers, so they get the full width.<br>• Side panels shrink on smaller windows. |
| **Mod Organizer 2** | Opens an MO2 instance and profile directly, using its virtual Data folder (loose files override BSAs). Saves go to Overwrite. |

## Running it

Requires Node 22+.

```bash
npm install
npm run dev:web     # browser demo on http://localhost:5173 (in-memory demo data, nothing touches your game)
npm run dev         # desktop app (Electron) with real file access
npm run build       # production build (web bundle + Electron main/worker)
npm run dist -w @tes5/studio   # Windows installer/portable build via electron-builder
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
- `packages/assets`: BSA (zlib/LZ4), NIF geometry and block-level editing (FaceGen head merging), DDS, FaceGen TRI
- `packages/navmesh`: navmesh generation (Recast), linking, validation
- `packages/workspace`: the editing engine (load order, MO2, virtual file system, edits/undo, services, automations, demo data)
- `packages/cli`: the `tes5` command-line tool
- `apps/studio`: the desktop/web editor (React, three.js, Monaco, Electron)

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit together.

## Disclaimer

This is an independent community tool, not affiliated with or endorsed by Bethesda. Keep backups of your plugins; the editor writes a backup before overwriting any file, but it is young software.
