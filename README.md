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

[The world](#the-world) · [Characters](#characters) · [Quests and dialogue](#quests-and-dialogue) · [Items, magic and scripts](#items-magic-and-scripts) · [The AI workspace](#the-ai-workspace) · [Your mod](#your-mod-records-cleaning-and-release) · [Finding your way](#finding-your-way)

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

#### Factions, classes and relationships

**Characters → Factions, classes & more** (the switch at the top of the Characters tab) lists the groups characters belong to and how they get along, laid out like Items and Magic: a category on the left, the records with a line about each, and a plain-language editor.

- **Factions:** who's in it and at which rank (add someone, change their rank or take them out; that character is changed in your plugin), the ranks with their titles for men and women, how members treat other factions and races (friends, allies, neutral, enemies), whether it can own beds, doors and chests, **crime** (a hold-style bounty for murder, assault, trespassing, pickpocketing, stealing, escaping jail and being seen as a werewolf, whether guards arrest or attack on sight, which crimes members ignore, the jail clothes) and **shops** (opening hours, what they trade, whether they buy stolen goods). Turning on a bounty starts with the values Skyrim's holds use.
- **Classes:** what a trainer with the class teaches and up to which level, how fast each of the 18 skills grows, how each level is split between health, magicka and stamina, and when they kneel instead of dying.
- **Leveled characters:** lists that pick a character by the player's level, like the bandits in a dungeon.
- **Relationships:** two characters, how they feel about each other (lover to archnemesis), how they're connected (parent and child, spouse, boss and employee…) and whether it's secret. They're listed by who they're between.

New factions, classes, leveled characters and relationships start with values like Skyrim's own, every change can be undone, and **Show every field** has the rest. A faction, class, leveled character or relationship opened anywhere else (Records, the properties panel, a link from the AI) has an **Open in Characters** button.

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

**Quests → From text:** paste a design document, or just a conversation with no tags, and an AI plans the whole quest. Pick the AI under **AI to use**:

- **Claude** gives the best plans, using your own Anthropic API key (paid).
- **Free on this PC** runs an open model on your own computer: free, private, and offline once downloaded. **Built in** (the default) needs nothing else installed: pick a model in the list and press **Download**, and the app fetches it from Hugging Face (checking it afterwards) together with [llama.cpp](https://github.com/ggml-org/llama.cpp), the program that runs it, and starts it when the AI is first needed. See [Free AI on your PC](#free-ai-on-your-pc) for the models and how they did. **Ollama** uses [Ollama](https://ollama.com) if you already have it: run `ollama pull qwen3:14b` (or `qwen3:8b` on smaller PCs), and pick it from the list. Bigger models make better plans; small ones may need a second try.
- **What the AI is given:** your text, the rules, and a list of what's in your load order. Characters, places and other entries your text mentions come first, and the characters it names come with their race, sex, voice, class and factions, so the AI reuses the right ones. A free AI also gets a short guide to the plan's fields (every field says what it's for) and a worked example to copy: the one closest to your text, out of three (a find-and-return quest; a rescue with fighting, a new cave, two endings and failure; new and changed characters with no quest), shown with the writing it was made from. A checklist of the mistakes small models make most comes last, after your text. Slips with an obvious meaning are mended without asking again: a name where a key belongs, an Editor ID with spaces, numbers or true/false in quotes, a missing start stage. When an answer is still wrong, the AI is told what each wrong field takes, and the plan's keys and stage numbers. Free AIs then write in steps: each conversation and the journal are rewritten one at a time with the whole plan in view, in Skyrim's style. A rewrite is kept only if it changes no stages and adds no mistakes. With any AI, a plan that would leave the quest stuck (a stage nothing reaches, a key that isn't in the plan) goes back once with the problems listed, and the better plan is kept. With Ollama, the app checks how much the model can read and sizes the window to fit; if the text is too long for the model, it says so instead of letting Ollama cut it.
- **Free online** uses a service with the OpenAI-style API. Google Gemini's free tier, NVIDIA's free developer API (DeepSeek, Kimi, GLM, Gemma and other large open models), Mistral's free plan, OpenRouter's free models, Groq and LM Studio are preset; each says how to get a key and what the free tier allows (Groq's free tier, for one, allows only about 8,000 tokens a minute, which one quest plan can go over). Click **Get a free key**, paste the key, and the app asks the service which models it offers right now and picks one, so the list never goes stale. The API address is for the app, not a web page to open.

The plan covers:

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

You check the plan first, in tabs: **Overview** (problems to fix and every decision Claude made on its own), **Cast & places**, **Story** (how it starts, stages and journal, objectives, what moves it on, how it can fail), **World events** and **Dialogue**. Problems that must be fixed show on whichever tab you're on, and the Build button stays at the bottom. You can edit the journal, objectives and dialogue directly, or ask Claude to change something ("make Eirik the thief"). **Build the quest** then creates everything (records, triggers, scripts, dialogue) as one undo step, and lists what still needs you (such as empty new interiors); new and changed faces get their face files when you save. **Use the example** tries it without any AI.

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

Monaco editor for Papyrus with live errors, completion, hover, signature help and an outline.

**Compiling needs no setup.** The Windows app comes with [Caprica](https://github.com/Orvid/Caprica), a free, open-source Papyrus compiler, so you don't need the Creation Kit's compiler.
- Saving a script compiles it in the background, like the Creation Kit. Saving the plugin compiles every one of your scripts that changed since its last compile.
- The Scripts tab shows how many scripts need compiling, with a button for just those, and **Compile all** for every script. Errors are clickable and take you to the line.
- **Compiling** shows what's ready. If the game's own script sources aren't unpacked yet, one click unpacks the Creation Kit's Scripts.zip.
- You can still pick PapyrusCompiler.exe or your own Caprica.exe there instead.

### The AI workspace

The **AI** tab is a conversation with an AI that works through the editor itself. It can look through your load order and your plugin with the same calls the other tabs use, and tell you what it found in plain words. It uses the AI chosen in **Settings → AI** (Claude, or a free one on your PC or online; the same choice as Quests → From writing).

- **Ask anything about your mod:** "What's in my plugin?", "How does this quest start?", "Where is Lydia used?", "What should I fix before release?". Starting points are offered when a conversation is empty.
- **Every tool the AI uses shows as a card** saying what it did ("Read DemoInnkeeper", "Run the release check"), with **Details** (what the tool returned) and **Open** (the record, quest, cell or script in its own tab).
- **Ask the AI from anywhere.** Quests, Characters, World, Scripts, the properties panel and Items/Magic have an **Ask the AI** menu with questions about what's open ("Explain how this quest works", "Which quests use this character?", "Dress and light this room"). Picking one opens the AI tab with the question ready to send.
- **What it costs.** A chip at the top of the conversation counts the tokens it has used and, with Claude, what that comes to (at $4 per million tokens read, $20 written, $0.20 read from the cache and $5 written to it). It's an estimate; your Anthropic console has the real bill.
- **Include what I have open** (on by default) tells the AI which quest, character, cell, record or script you have open, so you can say "this quest" or "her". Only names and FormKeys are sent.
- **What it can look at:** records found by name or Editor ID and kind, any record in full, the load order, a quest (stages, journal, objectives, aliases, what moves it on), a quest's dialogue (as a screenplay, with the dialogue check), places and what's in them, a character's routine, what uses a record, scripts (read and check), the Items and Magic categories, the release check and the conflict report.
- **Quests and dialogue it can make and change:**
  - **Whole quests from a description**, with the same planner as Quests → From writing. It tells you the plan (who, where, the stages and what moves them, questions) and builds it when you're happy. Plans can be revised in words or edited exactly, and are kept with the conversation, so one made yesterday can be built today.
  - **Changes to an existing quest** through a plan (only the differences are applied), or directly: add a stage or change its journal entry, remove a stage, add an objective and when it's shown and completed, make something move the quest on (talking to someone, killing, picking up, reading or using something, arriving somewhere, or right away), write a stage's script, add dialogue in screenplay form (checked first; nothing is added if it has errors), start the quest with the game, and fill in the journal and objectives.
  - **Dialogue that's already there,** line by line: reword what someone says or what the player says, change the emotion, when a line can be said (any time, only at a stage, from a stage on, before a stage, after the quest is done), which stage it moves the quest to, whether it ends the conversation, or remove a line or a whole player line with its answers. Lines from other plugins are reverted or disabled rather than deleted.
  - **It checks its own work.** After a turn that changed a quest, the editor's quest and dialogue checks run, and any problems go back to the AI once to fix.
- **Characters, items, magic and scripts it can make and change:**
  - **New characters**, copied from a fitting one and placed in a cell, exactly as planned characters are: look, outfit, inventory, factions, class, level, routine, combat, services (follower, marriage, merchant, trainer, innkeeper) and relationships. **Existing characters** change only in what you ask (overridden in your plugin).
  - **Items, spells, perks, lists and any other record:** a new one with sensible defaults (any Items or Magic category, or a record type), a copy of an existing one, changes to its fields (the AI reads a similar record first to learn the field names), or deleting one (records from other plugins are disabled or reverted instead).
  - **Scripts:** write a script (saved only if the editor's checker finds no errors, and undone with the turn), compile, attach to a record, set its properties or auto-fill them.
- **Places and the world it can build and change**, with the World tab's own tools:
  - **A new interior** copied from a fitting one (rooms, furniture, lights and clutter), with a linked door where the player comes in.
  - **Objects placed where they belong:** items on tables and shelves, furniture and characters on open floor, next to what you name ("by the fire", "behind the bar"); moved, turned, dropped to the floor or removed (objects from other plugins are disabled, not deleted).
  - **Rooms dressed and lit:** clutter for a tavern, home, storeroom, study, alchemy lab or smithy, a lighting mood, and lights for every candle, torch and fire.
  - **Doors and navmesh:** a door elsewhere that leads to an existing door, two doors linked to each other, and a cell's navmesh generated.
  - **Outdoors:** a new outdoor cell beside an existing one, or a whole new worldspace (its own map, with the weather and water of another); hills, hollows, flat building spots, ridges, valleys and roads shaped into the ground, with the cells around following along; and the ground painted with grass, dirt, rock or road textures, at a spot, along a line or over the whole cell. "Put a hill north of the village", "flatten a spot for a farm and paint it dirt", "run a road from the west edge to the east".
  - **Triggers on objects**, the same blocks as the Triggers editor: when the player uses, picks up, drops, hits, equips or reads something, it dies, or the player arrives nearby; if a quest is at a stage, the player has an item, or by chance; then set a stage, start a quest, show or complete an objective, show a message, give or take items, reveal, hide or unlock objects, move the player, and more. "Make the lever open the secret door", "give the player 50 gold the first time they open this chest". They go on placed objects or on a quest's alias, and can be changed or removed.
- **Bigger jobs become projects.** Ask for a questline, a town, a dungeon or a whole mod, and the AI writes a short **brief** and a **to-do list**, shown above the conversation. It works through the list one task at a time and stops after each task so you can look, then **Go on with the next task** carries on. The brief keeps the decisions you make along the way, and the to-do list goes with every message, so later tasks fit the earlier ones. When every task is done, **Review my mod** checks the whole plugin: the release check, conflicts with other mods, and every quest's problems. The project is kept with the conversation; **Remove** drops it and keeps everything it made.
- **You stay in charge of changes:**
  - **Ask before each change** (on by default): the AI stops before each change and waits for **Allow** or **Skip**. Turn it off to let it work and check afterwards.
  - **Each turn's changes are one undo step.** Under each turn that changed something, **Changes in this turn** lists them, with **Undo these changes**. Ctrl+Z does the same right after the turn.
  - Changes go into the plugin you're editing. If none is chosen, the AI tab offers to choose or create one, and the AI can still look around and answer questions.
- **Conversations are kept** in a list on the left (saved in `TES5EnvEditor/ai-conversations.json` next to your plugins) and can be deleted. **Stop** ends the AI's turn at once.
- **Claude** works through Anthropic's tool use. **Free AIs** use their own function calling (the built-in AI, Ollama, and services with the OpenAI-style API). A model that can't call tools is given them in words and answers in a small JSON format instead; a call written out as text is still taken. Small models get fewer tool calls per turn and shorter results.
- **Free AIs see the tools for what you ask.** All the tools' descriptions come to about 20,000 tokens, which is slow to read on a PC without a strong graphics card and too much choice for a small model. So a free AI is shown the few tools it always needs plus the ones for what your message, what you have open and the conversation so far are about (quests, characters, items, scripts, places, triggers, outdoors, checks, projects), about a third of the total; it can ask for any other group. Claude always sees everything.
- **Forgiving with small models.** Things can be named by in-game name as well as Editor ID or FormKey ("Iron War Axe", "Nord Mead"); a name that doesn't exist gets the closest matches back, so the next try uses a real one. A search for a kind in everyday words ("cell", "npc", "item") works, and a search that finds nothing shows what does match. A search for one kind of item also shows items of other kinds with that name (in Skyrim, mead is food and drink, not a misc item), and looking for a table to put something on gets told that placing an item finds the table itself. A chest or character named where a placed one is needed means its placed copy. A dialogue line can be named by its words. A call that already failed, a look already taken, or a change already made isn't repeated (placing and moving things can be); the AI is told to use what it has, and a turn that keeps repeating itself is stopped.

#### Free AI on your PC

**Settings → AI → Free on this PC → Built in** lists five small open models. Press **Download** on one and it's ready: the app fetches the model from Hugging Face and the program that runs it ([llama.cpp](https://github.com/ggml-org/llama.cpp)) from GitHub, checks the download, and starts it when the AI is first needed. Nothing you write leaves your PC, and it works offline once downloaded. The settings say whether it's running on your graphics card or the processor; **Stop** frees its memory.

**Run it on** chooses where it runs: the graphics card if there is one (several times faster), or the processor only. On some PCs a long job (planning a quest is the longest) keeps the graphics card so busy that Windows resets it, which can turn the screen black; the built-in AI gives the card smaller pieces of work and leaves room for the editor's window, and if the card still fails, it moves to the processor by itself, says so, and the window is drawn again with your work still open. Choose the processor if your screen flickers or goes black while the AI works.

Each model was tried on nine real jobs in the AI tab, against Skyrim Special Edition's own data (Skyrim.esm, Update.esm, the three DLCs and their BSAs), on a 4-core processor with no graphics card, which is about as slow as it gets:

| Model | Download | Memory it needs | Jobs done right | Time per job |
| --- | --- | --- | --- | --- |
| **Qwen3.5 4B** (recommended) | 2.7 GB | about 6.5 GB | 7 of 9 | about 3 min |
| Qwen3.5 2B | 1.3 GB | about 3 GB | 6 of 9 | about 2 min |
| Ministral 3 3B | 2.1 GB | about 7.5 GB | 6 of 9 | about 3 min |
| Gemma 4 E2B | 2.8 GB | about 4.5 GB | 5 of 9 | about 1 min |
| LFM2.5 1.2B | 731 MB | about 2 GB | 3 of 9 | under 1 min |

The jobs: say who works at the Bannered Mare and give its cell's Editor ID; add a stage with a journal entry to a quest; make a new war axe from the Iron War Axe with 12 damage; put two bottles of mead on a table in the Bannered Mare; show a message when Hulda's merchant chest is opened; make a quest's lines grumpier without adding any; make a small quest with two stages and an objective; make a new character (Ingrid, a Redguard blacksmith) standing in the inn; raise a hill about 5 metres high in an outdoor cell. Each job ran once per model with a 10-minute limit, and a job counts only if the plugin ended up right, so scores move a little from run to run. Placing objects was the hardest job: in that run every model got the mead wrong, mostly by searching for "a bottle of mead" or for the table instead of placing it. Searches now point to Nord Mead (in Skyrim it's food and drink, not a misc item) and say the table is found by itself; with that, Qwen3.5 4B, which had missed the mead in all five earlier runs, put two on a table in three steps, and also did the chest trigger it had run out of time on. That's one run each, so it can still miss. Qwen3.5 2B still went looking for a table first (and placed a new one).

**Quests → From writing** works with the built-in AI too, but slowly without a graphics card: from a short quest (Hulda has lost her mother's ring, Mikael the bard saw it fall, she pays 100 gold), Qwen3.5 4B made a plan with no errors that used Hulda and Mikael from Skyrim.esm, in about 22 minutes. Reading the planner's instructions and the list of what's in your load order (about 22,000 tokens) took 10 of them.

Tried and left out: Qwen3.5 0.8B (3 of 9, and its changes were often wrong), LFM2.5 2.6B (most jobs ran out of time), Phi-4-mini and SmolLM3 (they answered in words and never used the tools), and Granite 4.2 3B (it did the jobs it finished, but at about a word a second; one job took 11 minutes).

With a graphics card (any make: llama.cpp uses Vulkan) the models run several times faster; that hasn't been measured here. For quests and bigger jobs, a free online AI (**Free online**: Gemini, or NVIDIA's free API with large open models) is quicker and makes fewer mistakes, and Claude is best. To try a model yourself, run `SKYRIM_DATA=<your Data folder> npx tsx apps/studio/test/models/model-trial.ts <server address> <model>` against any OpenAI-style server.

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

- **On every save (your choice):** remove identical-to-master records, recalculate object bounds, write SEQ files, generate face files for characters whose look changed, compile scripts that changed.
- **Always:** masters added and sorted, parent records copied, counts and dialogue order kept right, alias IDs, fragment scripts and their properties, safe deletes, backups, strings files, undo for everything.

The tab also points to the automation tools in the other tabs.

#### Release

A final tab before sharing your mod:

- **Pre-release check:** finds missing meshes and textures, uncompiled scripts, empty script properties, aliases that can't fill, unvoiced lines, characters without a voice, characters whose face files are missing or out of date (fixed with one click), floating or sunk items, one-way doors, missing or out-of-date navmeshes, wrong bounds and dirty edits. Each result links to the problem, and many have a one-click fix.
- **Character faces (FaceGen export):** every character in your plugin with the state of its face files (up to date, out of date, missing, uses its template). **Generate faces** makes all the changed ones; tick any others and **Export ticked** to write them again, like the CK's Ctrl+F4. Tints are written like the CK's (BC3 with mipmaps). Characters that take their looks from a template are recognised and need no files.
- **Light plugin (ESL)** check, FormID compaction, and a **Flag as ESL** button (undoable).
- The check updates by itself after each change.
- **Conflicts:** which of your records other mods also change, and whose version the game uses.
- **Pack into a BSA** (your plugin's own files, named so the game loads it) or **Pack as a ZIP** (plugin plus files, optionally in a BSA, ready to upload).

#### Mod Organizer 2

Opens an MO2 instance and profile directly, using its virtual Data folder (loose files override BSAs). Saves go to Overwrite, unless you choose a folder (below).

#### Save into a new folder

On the start screen, **Where my files are saved → Save into a new folder** sends everything the editor writes (your plugin, scripts, SEQ and face files, backups) into one folder you pick or type, made if it doesn't exist. It works the same whether you open a Skyrim folder or Mod Organizer 2, and for any mod manager: add the folder as a mod (MO2, Vortex) or copy it into Data. The choice is remembered, and the next screen shows where files will go. Left off, saves go to the Data folder, or to Overwrite in MO2 as before.

### Finding your way

#### Easy to find your way

- One-row toolbars, with camera and display options under **View** and navmesh actions under **Navmesh**.
- The Outliner and World tools share a panel beside the 3D view.
- Press **?** for every keyboard and mouse shortcut.
- **Quest stages and dialogue:** select a response in the Dialogue tab. **When can this be said?** sets it in plain words (only at a stage, once a stage is reached, before a stage, after this or another quest is completed), with the stages listed by their journal text. **After this line** moves the quest to a stage when the line is said. Chips on each response show both, and clicking one opens that stage on the map. Anything more specific is under **Advanced** (the full condition list). The **Stages** tab lists, under each stage, the lines said at it and the lines that move the quest to it. **Dialogue available** (Overview, or the **Availability** button in the Dialogue tab) sets when all of the quest's dialogue can be said: from a stage on, and not once the quest is completed.
- **Bigger text box for dialogue:** the button beside a player line or response opens it in a large box. It saves when you click off the box.
- **App menu:** click the logo in the top-left. **Save** and **Settings** come first (Settings has the "every time you save" options and links to the compiler and plugin setup), then New plugin, Close game folder (it asks first if you have unsaved changes), Undo and Redo (named after what they undo), New character / quest / script, the properties panel switch, Test in game, a list of keyboard shortcuts and About. Anything that can't be used yet is greyed out, and its tooltip says why.
- A **(?)** next to settings and options explains what each one does.
- Settings live where they're used: compiling under Scripts → Compiling, snapping under View → Snapping settings.
- The properties panel (every field of the selected form) can be hidden from the top bar. It starts hidden in the Characters and Quests designers, so they get the full width.
- Side panels shrink on smaller windows, and the World toolbar drops its words (keeping icons and tooltips) when the 3D view gets narrow.
- **Start screen:** finds Skyrim in your Steam libraries and GOG folders, so you usually just click **Open**. The plugin list has search and **All / Only masters / None**, and unticking a master unticks the plugins that need it.
- **Dialogs remember what you typed.** Close a New quest, New character, New script, New cell or quest-from-text dialog (Cancel, Esc or a click outside) and it is filled in again next time, until the thing is created.
- **Empty screens say what to do next**, with a button for it (New character, New quest, Describe a quest, New script).
- Character and quest lists can show **only the ones in your plugin**, and say when there are more than they show.
- Conditions show names, not numbers: skills and stats ("One-handed", "Health"), crime types, hands, alignment.
- Records lists name placed objects after what they place ("Barrel (placed)").
- Escape closes any dialog, even while typing.

## Running it

Requires Node 22+.

```bash
npm install
npm run dev:web     # the UI in a browser on http://localhost:5173, for development and tests only (in-memory demo data)
npm run dev         # desktop app (Electron) with real file access
npm run build       # production build (web bundle + Electron main/worker)
npm run dist -w @tes5/studio   # Windows installer + portable exe in apps/studio/release
```

When you start the desktop app you can open either:

- your Skyrim folder, or
- a Mod Organizer 2 instance folder.

Then choose the plugins to load and the plugin your changes go into. Scripts compile with the Caprica that comes with the app. The Creation Kit is only needed once, for the game's script sources (Scripts.zip); **Scripts → Compiling** unpacks them for you.

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

This is an independent community tool, not affiliated with or endorsed by Bethesda. The Windows app includes Caprica v0.3.0 (MIT license, by Orvid King and contributors), unchanged, with its license. Keep backups of your plugins; the editor writes a backup before overwriting any file, but it is young software.
