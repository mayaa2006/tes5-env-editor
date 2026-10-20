# Changelog

Each version here is published as a Windows installer and portable exe on the [releases page](https://github.com/mayaa2006/tes5-env-editor/releases).

## 0.36.0

- **Free AIs now make whole quests in the AI tab.** Asked to make a quest, a free AI (the built-in one, Ollama or a free online service) was shown the tools for editing a quest a piece at a time but not the quest planner. So it made the quest a stage and a line at a time, ran out of steps, and left a quest that nothing moved on. Now, when you ask for a new quest, it gets the planner. The planner makes the whole quest (characters, places, items, stages, journal, objectives, what moves it on, dialogue), tells you what it will build, and builds it when you say so. The first message the AI reads is a quarter of the size it was, so a PC without a strong graphics card answers about four times sooner. A model you've already downloaded is used without pressing **Use** first.
- **Quests can use items a character carries.** Examples: "kill the bandit leader and take the amulet from his body", or "she hands you the sword to take to her father". When the quest starts, the item is made in that character's inventory. Taking it, looting it, reading it or dropping it moves the quest on, and its quest marker points at it. `[gives …]` and `[takes …]` in dialogue hand over that same item, not a new copy. Before, the quest couldn't tell any of this happened, so the rest of the quest could never be reached. The character's own record is also no longer changed to carry it.
- **Rewards can be training in a skill**, as in "Faendal teaches you archery": the player goes up one or more levels in the skill at a stage. In dialogue, `[skill Archery x1]` on a line does the same when it's said.
- **Doors outdoors for new interiors.** The planner now sees the outdoor places your text mentions (in Skyrim, outdoor cells have Editor IDs such as PelagiaFarmExterior or RiverwoodEdge01). So a new farmhouse "outside Whiterun" gets a linked door out there, with a note to move it into place.
- **"A new farmer called Eirik" makes a new character.** Qwen3.5 4B planned Eirik as an existing Skyrim farmer (WEDL14Farmer) and would have renamed and reworked him. Now a character planned as an existing one with a different name, who your text doesn't name, becomes a new character copied from them, and the plan says so.
- **Free AIs no longer rewrite characters you didn't ask to change.** Asked for a quest with Hulda in it, Qwen3.5 4B also changed her class, level, routine and roles, which would override her in your plugin and could change how she behaves in game. Now a change to a character who's already in the game is kept only when your text talks about that kind of thing (making her essential, a new outfit, joining a faction). Quest behaviour such as following the player or walking up to speak is kept. The plan says who was left as they are.
- **New quest items look like what they are.** An item is copied from one named like it ("Hulda's Ring" from a ring) instead of the first misc item in the load order (an Aetherium Crest). The copy doesn't keep any scripts the original had for its own quest. New clothing and armour with no name match are copied from armour again; before, they became misc items.
- **Plans that would leave the quest stuck, or let the player skip it, go back to the AI.** New checks:
  - a step that happens "in a conversation" with no line of dialogue that sets its stage;
  - an item the player must hand over (or have) but never gets, or has to pick up from someone who never hands it over or dies;
  - a character taking a quest item on a line that doesn't move the quest on, so the player can't finish;
  - a line that sets the stage that killing the wolves (or picking something up, or arriving somewhere) should reach, so the player can talk their way past it;
  - a journal entry on the first stage of a quest that runs from the start, which would show in the journal before the player has met anyone;
  - a "right away" step into a stage that fails the quest, so it fails as soon as the stage before is reached;
  - a line that moves the quest on whenever it's chosen ("I'll take the gold" offered before the amulet is found), so the player can skip ahead. In an AI's plan it's tied to the stage the plan's own step says it belongs to.

  The planner sends these back to the AI to fix before you see the plan, and the plan review shows them too. Each one turned up in quests Qwen3.5 4B planned on Skyrim's data.
- **Small models fill the gaps one at a time.** Rewriting a whole plan to fix one missing line is too much for a small model; Qwen3.5 4B gave back the same plan. Now, for each step that happens in a conversation that nothing says yet ("the player gives Proventus the sword"), a free AI is asked for just that short exchange, and it's added to that character's conversation. "Right away" steps that would fail the quest, where a time limit or death already fails it, are taken out without asking.
- **A tag the editor doesn't know no longer stops an AI's plan from building.** Qwen3.5 4B wrote `[skill Archery levels 10]` before that tag existed, the build was refused, and it spent the next hour re-planning. Near-misses (`[give …]`) are now mended and inventions taken out, with a note.
- **The AI can fix a plan by editing it**: an edited plan with a list left out or `[]` written for "none" is mended instead of turned down (Qwen3.5 4B had three edits rejected in a row). After building, the AI is also told about any stage nothing leads to.
- **Enemy groups get a quest marker**, so "Kill the three wolves" points at them. Plurals in your text match the load order too: "wolves" finds LvlWolf and "bandits" finds the bandit types, instead of "forest predators" (bears and sabre cats as well).
- **Building a revised plan updates the quest instead of making a second one.** After building, the AI sometimes revised the plan and built it again, which left two copies of the quest in your plugin. Now a plan remembers the quest it made, and building it (or a revision of it) again only applies the differences.
- **A shorter load-order list for free AIs.** It now leads with what's useful (the ten playable races, everyday voices and classes, the factions and outfits your text is about) instead of giants, atronachs and creature voices in alphabetical order. That cuts about a fifth of what a free AI reads before planning, and characters still get the full list.
- **The release check says when a quest needs a character who isn't placed anywhere in the world.** That alias can't be filled, so the quest wouldn't start.
- **Fixed:** a quest plan whose dialogue used `[if has ring]` (the planner is told to use it) failed to build with "no item called ring".
- **Fixed:** the Papyrus checker reported "PlayIdle is not a function on Actor" in quest scripts that act on a character alias. It hadn't loaded the types that functions return.
- New characters described as bald get no hair when their race has no bald hair style, and the note "they stand where they're placed until you give them AI packages" is no longer shown for characters given a routine.
- **Tried on Skyrim's own data:** RESULTS

## 0.35.1

- **Fixed: the screen could go black when the built-in AI made a quest.** Asking for a quest gives the AI its biggest job, and on some PCs the graphics card is kept busy so long that Windows resets it, which leaves the editor's window black. The built-in AI now works the graphics card in smaller pieces and leaves 1.5 GB of its memory free for the window. If the card still fails, the AI moves to the processor and says so, and the window is drawn again with your work still open.
- **Run the built-in AI on the processor only.** Settings → AI → Free on this PC → Built in → **Run it on**: the graphics card if there is one (faster), or the processor only (slower, never affects the screen).
- **A part of the window that fails to draw now says what went wrong**, with **Try again** and **Copy the details**, instead of turning black. Your work stays open; the rest of the window keeps working.
- When the built-in AI stops in the middle of an answer, the AI tab says why (its graphics card stopped responding, or it ran out of memory) instead of "couldn't reach".

## 0.35.0

- **Factions, classes, leveled characters and relationships, in plain words.** The Characters tab has a new switch, **Factions, classes & more**, laid out like Items and Magic. Factions show who's in them (add someone, change their rank or take them out), their ranks and titles, who they're friends or enemies with, crime bounties and jail clothes, and shop hours and goods. Classes show what they train, how fast each skill grows, and how health, magicka and stamina grow. Relationships say who and how they feel about each other. New ones start with values like Skyrim's, and everything can be undone.
- **Open in Characters, Items or Magic** from Records and the properties panel, for anything those workspaces edit. Links from the AI tab open the record at its category too.
- **The AI knows the new categories**, so you can ask it to make a faction, a class or a relationship.
- **Fixed:** Ctrl+Z, Ctrl+S and the other shortcuts did nothing while a checkbox or slider had focus.

## 0.34.1

- **Free AIs find the right thing to place.** A search for one kind of item ("mead" as a misc item) also lists items of the other kinds with that name. In Skyrim, Nord Mead is food and drink, and it was never mentioned before. Dialogue topics are no longer offered as "other kinds". Looking for a table, shelf or counter to put something on now gets told that placing an item finds one by itself. Re-run on Skyrim's data, Qwen3.5 4B put two Nord Meads on a table in the Bannered Mare in three steps (it had missed that job in all five earlier runs); Qwen3.5 2B still struggles with it.
- **Quest plans with the built-in AI, tried.** Qwen3.5 4B planned a short quest from writing on Skyrim's data with no errors, using Hulda and Mikael from the game. It took about 22 minutes on a processor without a graphics card. The README says so.
- **Fixed:** opening the bigger text box for a dialogue line again straight after saving it could show the old text, and closing it then could put the old text back. This was most likely in the desktop app, where saving takes a moment longer.

## 0.34.0

- **A free AI that runs on your PC, in one click.** Settings → AI → Free on this PC → Built in: pick a model and press Download. The app downloads it and the program that runs it (llama.cpp), checks the download, and starts it when the AI is first needed. Nothing else to install, no account, and it works offline afterwards. It runs on your graphics card if you have one (NVIDIA, AMD or Intel), otherwise on the processor. Downloads carry on where they stopped if interrupted. Ollama still works too.
- **Small models tried on Skyrim's own data.** Every model offered was tried on nine real jobs against Skyrim SE's own records and meshes (finding who works at the Bannered Mare, adding a quest stage, making a weapon, putting mead on a table, a trigger on a chest, rewording dialogue, a whole small quest, a new character, a hill outside Whiterun). Five are offered: Qwen3.5 4B (recommended, 7 of 9 jobs right), Qwen3.5 2B and Ministral 3 3B (6 of 9), Gemma 4 E2B (5 of 9, and quick) and LFM2.5 1.2B (the smallest, 731 MB; 3 of 9). Five more were tried and left out. The README has the table.
- **Free AIs work better in the AI tab.** They're shown only the tools for what you ask (a third of the reading, so much faster on a PC without a strong graphics card), with a way to ask for more. They can name things the way you do ("Nord Mead", "the chest"), get the closest matches back when a name is wrong, and don't repeat a call that already failed or make the same change twice; a turn that keeps going round in circles is stopped. Answers now stream in, so a long answer on a slow PC no longer gives up after five minutes.
- **More free online AIs.** NVIDIA's free developer API (DeepSeek, Kimi, GLM, Gemma and other large models) and Mistral's free plan are in the list, each with how to get a key and what the free tier allows.
- **Fixed:** undoing an AI turn that wrote the same quest script twice could leave the wrong version of the script on disk, and two saves of one file at the same moment could stop the editing engine. A script file that can't be written back on undo (locked, disk full) is now reported when you save instead of restarting the engine.
- **Fixed:** in the browser demo, free AIs in the AI tab failed to send anything, and the new online services were blocked by the page.

## 0.33.0

- **The AI can work outdoors.** Ask it to add an outdoor cell next to one you have, make a new worldspace, raise a hill, dig a hollow, flatten a spot to build on, run a ridge or a road across a cell, or paint the ground with grass, dirt, rock or road. Hills come out about as high as you ask, the cells around follow along, and each change is one undo step.

## 0.32.0

- **The AI can add triggers to objects.** Ask for a lever that opens a secret door, a chest that rewards the player once, a quest item that moves the quest on when picked up, or a message when the player arrives somewhere. The AI writes them as the same "when… if… do…" blocks you see in the Triggers editor, so you can check and change them there, and it can change or remove them later.

## 0.31.0

- **The AI can change dialogue that's already there.** Ask it to reword a line, change who it suits ("make her sound angrier"), say it only at a certain stage, make it move the quest on, end the conversation, or remove it. It goes line by line through the quest's dialogue, the same as the Dialogue tab, and checks the dialogue afterwards. One Undo takes it all back.

## 0.30.0

- **Ask the AI from any workspace.** Quests, Characters, World, Scripts, the properties panel and Items/Magic have an **Ask the AI** menu with questions about what you have open ("Explain how this quest works", "Which quests use this character?", "Dress and light this room", "Find bugs in this script"…), or your own. The AI tab opens with the question ready and knows which record you mean.
- **See what a conversation costs.** The AI tab counts the tokens each conversation uses and, with Claude, estimates the cost. Hover it for the details.

## 0.29.1

- **The AI's quest plans are kept with the conversation.** A plan made in the AI tab can be revised and built after closing and reopening the app, instead of being lost.

## 0.29.0

- **Bigger jobs in the AI tab become projects.** Ask for a questline, a town, a dungeon or a whole mod, and the AI writes a short brief and a to-do list (shown above the conversation), then works through it one task at a time. It stops after each task so you can look; **Go on with the next task** carries on. Decisions you make along the way go into the brief, so later tasks fit the earlier ones.
- **Review my mod**, when a project is finished or any time you ask: the release check, conflicts with other mods and every quest's problems in one list, most important first.
- New starting points: **Plan a bigger job** and **Review my mod**.

## 0.28.0

- **The AI tab can build and change places.** It uses the World tab's own tools:
  - **New interiors** copied from a fitting one, with a linked door where the player comes in.
  - **Objects where they belong:** items on tables and shelves, furniture and characters on open floor next to what you name ("by the fire"); moved, turned, dropped to the floor or removed.
  - **Rooms dressed and lit** for their use (tavern, home, storeroom, study, alchemy lab, smithy), with a lighting mood and lights for candles and fires.
  - **Doors and navmesh:** linked doors, and a cell's navmesh generated.
- New starting point: **Dress and light a room** (the cell you have open in the World tab).

## 0.27.0

- **The AI tab can make characters, items, magic and scripts.**
  - **Characters:** a new character is copied from a fitting one, placed where you say, and given the look, clothes, inventory, factions, class, level, routine, fighting style, services (follower, marriage, merchant, trainer, innkeeper) and relationships you describe. Existing characters change only in what you ask.
  - **Items, spells, perks and lists:** new ones, copies of existing ones, changed fields (the AI looks at a similar record first), or removed ones.
  - **Scripts:** written only if the editor's checker finds no errors, then compiled, attached and given their properties (or auto-filled).
  - As with quests, each change can wait for **Allow**, and a turn's changes undo together (scripts too).
- Two new starting points on the AI tab: **Make a character** and **Make an item or spell**.

## 0.26.0

- **The AI tab can make and change quests and dialogue.**
  - **A whole quest from a description.** It plans it with the same planner as Quests → From writing, tells you the plan, and builds it (characters, places, items, stages, journal, objectives, dialogue) when you're happy.
  - **Changes to quests you have**, through a plan or directly: stages and journal entries, objectives, what moves the quest on (talking, killing, picking up, reading, using, arriving, right away), stage scripts, dialogue (checked before it's added), starting with the game, and the journal and objectives worded like Skyrim's.
  - **It checks its own work.** After changing a quest, the editor's checks run and any problems go back to the AI to fix.
- **You stay in charge.** **Ask before each change** is on by default: the AI waits for **Allow** or **Skip** before each change. Each turn's changes are listed under it and undo together with **Undo these changes** (or Ctrl+Z). If no plugin is chosen yet, the tab offers to choose or create one.

## 0.25.0

- **New AI tab: talk to an AI about your mod.** Ask in plain words ("What's in my plugin?", "How does this quest start?", "Where is Lydia used?", "What should I fix before release?") and the AI looks for itself, using the editor's own tools: it searches and reads records, the load order, quests and their dialogue, places and what's in them, routines, scripts, the Items and Magic categories, the release check and the conflict report.
  - **You see what it did.** Each tool it uses is a card ("Read DemoInnkeeper", "Run the release check") with **Details** and an **Open** button that takes you to that record, quest, cell or script.
  - **"This quest", "her".** With **Include what I have open** ticked, the AI knows what you have open in the other tabs.
  - **Conversations are kept** in a list, can be deleted, and **Stop** ends the AI's turn at once.
  - **Any AI.** Claude, or a free one: Ollama on your PC or a free online service. Models that can't use tools get them in words instead.
  - It only reads for now. Making changes (quests and dialogue first) comes next.
- **The AI settings are in Settings** (the menu behind the logo) as well as where they're used.

## 0.24.0

- **Free AIs get better examples and instructions.**
  - **The example that fits your text.** There are now three worked examples instead of one, and a free AI gets the one closest to what you wrote: finding and returning something; a rescue with bandits in a new cave, a boss you can spare or kill, two endings and failure if the hostage dies, started by reading a note; or new and changed characters with no quest (a merchant, trainer and follower, and a beard for someone who exists). Each comes with the writing it was made from, so the AI sees how writing turns into a plan.
  - **A checklist at the end.** After your text comes a short list of the mistakes small models make most (names instead of keys, made-up Editor IDs, stages nothing reaches, dialogue that moves the quest without a step), to check before answering.
  - **Every field explained.** The field guide now says what every field is for, including the ones that used to be bare (stage flags, objective and reward stages, step kinds, where an item starts).
  - **Small slips are mended for you.** A name used where a key belongs ("Brynja" for "brynja"), a quest Editor ID with spaces, numbers or true/false in quotes, "Male" for "male", a list given as null, or no stage marked as the start are fixed without another round trip.
  - **Clearer second tries.** When an answer doesn't match the format, the AI is told what each wrong field takes. When a plan refers to something that isn't in it, it's given the plan's keys and stage numbers to fix it against.
- **Claude benefits too:** the field descriptions are part of the plan format it's given, and the same slips are mended.

## 0.23.0

- **Free AIs write quests in steps, and better.** After the plan is made, each conversation is rewritten on its own, then the journal and objectives, with the whole plan in view and a short guide to how Skyrim's characters talk: short lines, fitting words, real choices for the player, and lines for when you come back early. A rewrite is only kept if it moves the quest the same way and adds no mistakes, so this can only improve the plan. It takes a little longer.
- **Plans that would get stuck are fixed before you see them** (with any AI). A stage nothing reaches, a step pointing at something that isn't in the plan, or a quest that never starts or ends is sent back to the AI once with the problems listed, and the better of the two plans is kept.
- **The review warns about unreachable stages:** "Nothing moves the quest to stage 20…".

## 0.22.0

- **Each stage shows its dialogue.** On the Stages tab every stage card has a **Dialogue** list: the lines only said at that stage, said from it on, said until it, and the lines that move the quest to it. Click one to open it in the Dialogue tab. A stage with none says how to add some.
- **Set when all of a quest's dialogue is available.** **Dialogue available** on the Overview tab (also the **Availability** button in the Dialogue tab, and at the top of the list view): either whenever the quest is running, or once it has reached a stage, with a tick to **stop offering it once the quest is completed**. It uses the quest's own dialogue conditions, so it applies to every line; a line's own "When can this be said?" narrows it further (both must be true). Any other dialogue conditions on the quest are left as they are.

## 0.21.0

- **Free AIs get more context and plan better.**
  - **The right load-order entries.** Characters, places and other entries your text mentions come first, so they're never cut off the list. The characters it names come with their race, sex, voice, class and factions, so the AI picks the right existing people.
  - **More room for your text.** The plan's format is now sent as a short field guide instead of the raw format file: about half the size, and easier for small models to follow.
  - **A worked example.** Free AIs get one complete example plan to copy the shape of. Small models follow examples much better than long rules.
  - **No silent cut-offs with Ollama.** The app asks the model how much it can read and sizes the window to fit. If your text is too long for the model, it says so, instead of Ollama quietly cutting the start (where the rules are).

## 0.20.0

- **Set when a line is said, in plain words.** Every response in the Dialogue tab (graph and list) has **When can this be said?**: at any time, only while the quest is at a stage, once the quest has reached a stage, only before a stage, after this quest is completed, or after another quest is completed. Stages are listed with their journal text ("20 – Find the ring"). It writes ordinary conditions, so the full list is still under **Advanced**, and conditions you already had are read back correctly.
- **Move the quest from a line.** **After this line** has a stage dropdown ("Don't change the quest" by default): the quest moves to that stage when the line is said. No script needed, and it shows as an arrow on the quest map. Ending the conversation moved here too.
- **Stage chips on dialogue.** Responses show what they need and what they do ("only at 10 – …", "from 20 – …", "until 30 – …", "→ 30 – …"). Click a chip to open that stage on the map.

## 0.19.0

- **Flag a plugin as a light plugin (ESL).** The Light plugin card on the Release tab now has a **Flag as ESL** button, enabled when the plugin qualifies. If it doesn't qualify yet, the tooltip says to use **Compact FormIDs** first. Once flagged, the card shows **flagged ESL** and a **Remove ESL flag** button. Both can be undone; save to keep the change.

## 0.18.2

- **Packing no longer includes script sources (.psc) by default.** The BSA and ZIP hold only the compiled scripts; tick **Include script sources** on the Release tab if you want to ship them.

## 0.18.1

- **Edit dialogue in a bigger box.** Player lines and responses have an expand button beside them. It opens the text in a large box, and what you typed is saved when you click off it (or press Done, Escape or Ctrl+Enter). Each save is one undo step.

## 0.18.0

- **A menu in the top-left corner.** Click the logo to open it. **Save** and **Settings** are at the top, then **New plugin**, **Close game folder** (asks first if you have unsaved changes), **Undo** and **Redo** (named after what they undo), **New character**, **New quest**, **New script**, the **Properties panel** switch, **Test in game**, **Keyboard shortcuts** and **About**. Items that can't be used yet are greyed out and the tooltip says why.
- **Settings** opens from the menu and holds the "every time you save" options, with shortcuts to the script compiler and plugin setup.
- **A new logo,** and the app name no longer squashes the logo or wraps onto three lines. On small windows the Test button shows just its icon so the top bar fits.

## 0.17.1

- **Fix:** the demo no longer talks about a "browser version" or "the desktop app". The app has no browser version. In the demo (where files live only in memory), compiling and starting the game now say they aren't available in the demo, and tell you to open your Skyrim folder.

## 0.17.0

- **Compiling scripts is automatic.** The app comes with Caprica, a free, open-source Papyrus compiler, so the Creation Kit's compiler isn't needed.
  - Saving a script compiles it in the background, as before. Now saving the plugin also compiles your scripts that changed. Both are on by default; switch them off in Automations or Scripts → Compiling.
  - Problems are listed after saving, and the save always goes through.
- **The Scripts tab shows if your scripts are compiled.** It says how many need compiling, with a button to compile just those. **Compile all** and compiling in the background hand Caprica every waiting script at once.
- **Scripts → Compiling** shows what's ready, in two steps:
  1. The compiler: Caprica by default. You can pick PapyrusCompiler.exe or your own Caprica.exe, and go back to the automatic one.
  2. The game's script sources: **Unpack Scripts.zip** unpacks the Creation Kit's sources into Data. If the zip is missing, it says where to get it.
- **The release check compiles for you.** "isn't compiled" now has a **Compile** button for your own scripts.
- **Fix:** Caprica's error lines are read properly (the line number and message show up and are clickable).

## 0.16.0

- **Compile all scripts with one button.** Scripts → **Compile all** compiles every script in your mod in the background, shows progress on the button, and tells you how many failed. Open a failed script to see its errors; clicking an error jumps to the line.
- **Scripts compile in the background when you save**, like the Creation Kit. You keep typing; you only hear about it if it fails. Turn it off under Scripts → Compiler → *Compile in the background when I save a script*.
- A script's **not compiled** tag clears as soon as its .pex is built.

## 0.15.1

- **Free online AI works with current models.** Model names are no longer guessed:
  - After you paste a key, the app asks the service which models it offers now and picks one. **Find models** asks again.
  - A model the service has dropped is swapped for one it still offers.
  - The defaults are updated: Gemini's free model is now gemini-3.8-flash, and OpenRouter's old free Llama model is gone.
- **Clearer links:** **Get a free key ↗** opens the service's key page in your browser.
  - The **API address** is marked as being for the app, not a web page: opening it in a browser always shows an error.
  - Ollama's download page is a link too.
- **A wrong key shows up straight away**, before you plan.
- **Fix:** in the browser demo, Gemini, Groq and OpenRouter were blocked by the page's security settings.

## 0.15.0

- **Save into a new folder, whatever your setup.** On the start screen, **Where my files are saved → Save into a new folder** puts your plugin and everything else the editor writes (scripts, SEQ and face files, backups) into one folder you choose, made if it doesn't exist. It's the same with a Skyrim folder or Mod Organizer 2, so it suits any mod manager. The choice is remembered, and the plugin screen shows where files will go. Off by default: saves go to Data, or MO2's Overwrite, as before.

## 0.14.1

- **Closing a dialog no longer loses what you typed.** New quest, New character, New script, New cell / worldspace and the quest-from-text box keep their fields when you cancel, press Esc or click outside, and are filled in again next time you open them. They start fresh once the thing is created.

## 0.14.0

- **Plan quests with a free AI.** Quests → From text has a new **AI to use** choice:
  - **Claude**: the best plans, with your own Anthropic key (paid), as before.
  - **Free on this PC**: an open model running on your own computer through Ollama. Free, private, works offline. The app finds the models you've installed. If Ollama isn't running, it shows the three steps to set it up.
  - **Free online**: a service with the OpenAI-style API. Google Gemini's free tier, Groq, OpenRouter's free models and LM Studio are preset.
- The same AI writes journals (**Word with the AI**) and changes plans when you ask.
- Free models make weaker plans than Claude. To help:
  - Their answers are tidied up (code fences, thinking text).
  - Missing lists are filled in.
  - A wrong answer gets one retry, told exactly what was wrong.
- Your choice is remembered.

## 0.13.2

- **Quests list shows only quests with names by default.** A new **Only quests with names** checkbox above the list is ticked at the start; untick it to see unnamed quests too.

## 0.13.1

- **Fix: characters in the World view no longer show white skin and black clothes while loading.** A character stays a simple placeholder until all its textures are in, then appears complete.
- **Fix: hair, beards and brows in the World view take the character's hair colour** (their own, else their race's), as in game and in the character creator. Before, they showed the grey texture underneath.

## 0.13.0

- **New worldspaces:** Cells → **New worldspace**. Start with a square of flat ground (1×1 up to 7×7 cells), pick a ground texture, water, and weather and music like another worldspace (Tamriel by default). Its persistent cell is made too.
- **New outdoor cells:**
  - **+ Cell** on a worldspace in the Cells list fills in the nearest free spot.
  - In the scene, a dashed **E+** (or W+, N+, S+) means there's no cell that way yet: click it to make one and go there.
  - The new ground meets the cells around it without a step, and uses their ground texture and water.
- **New cell dialog** has three tabs: **Indoors**, **Outdoors** and **New worldspace**.
- Outdoor cells without an Editor ID show as **Wilderness** (with their grid position) instead of a form ID.
- **Fix:** an empty outdoor cell is framed when you open it.
- **Fix:** editing a vanilla worldspace's persistent cell kept it where the game expects (directly under the worldspace), not in a cell block.

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
