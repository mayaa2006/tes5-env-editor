# TES5 Env Editor

An automation-first alternative to the Skyrim Creation Kit for quests, characters, environments and scripting, with SSEEdit-style plugin cleaning built in.

The editor reads and writes Skyrim LE/SE plugins (`.esm`/`.esp`/`.esl`) itself. It does not drive the Creation Kit.

> **Status: early.** The core works end to end on the bundled demo data set, with automated tests for each part. It has **not** been tested against a full Skyrim.esm load order. See [ROADMAP.md](ROADMAP.md) for what's done, what's partial and what's missing.

## What it does

| Area | Highlights |
| --- | --- |
| **World** | Three.js viewport with Blender controls:<br>• **Navigation:** MMB / Alt+LMB orbit, Shift pan, wheel zoom, RMB + WASD fly, numpad views, F / Home to frame.<br>• **Transforms:** G/R/S with X/Y/Z axis constraints, typed values and Ctrl snapping. Also a gizmo and a snap toggle.<br>• **Editing:** Shift+D duplicate, X delete (master references are disabled safely, never deleted), H/Alt+H hide.<br>• **Drag and drop:** drag base objects or raw `.nif` files from the browser into the scene. A Static base record is created for meshes automatically, with bounds.<br>• **Scene:** outliner, LAND terrain, cell lighting preview. |
| **Navmesh** | One-click generation from cell geometry and terrain (Recast). Doors are linked automatically and exterior cells are stitched to their neighbours. Tab enters an edit mode where you can delete triangles and set the preferred / water / no-large-creatures flags. |
| **Characters** | A RaceMenu-style creator:<br>• race, sex, weight and height;<br>• head parts filtered to the race and sex;<br>• all 19 face sliders, previewed live with chargen morphs;<br>• hair colour, skin tone and tint layers.<br>It also warns about missing FaceGen files (the dark-face bug). |
| **Quests** | One screen per quest:<br>• stages with journal text and inline stage scripts;<br>• objectives and aliases;<br>• dialogue laid out as a conversation, with a condition editor and begin/end scripts;<br>• a stage flow graph and voice-file names. |
| **Scripts** | Monaco editor for Papyrus with live errors, completion, hover, signature help and an outline. Compiling uses PapyrusCompiler.exe or Caprica, with clickable errors. |
| **Cleaning** | Quick-Auto-Clean equivalent:<br>• removes identical-to-master records (ITMs), with a "safe" mode that keeps deliberate reverts;<br>• undeletes and disables deleted references (UDRs);<br>• can optionally restore deleted navmeshes.<br>Analyze shows what would change before you clean. Also available from the CLI. |
| **Records** | A schema-driven form for every supported record type, plus an xEdit-style conflict view comparing each plugin's version. |
| **Automatic** | • Masters added and sorted<br>• Counts and record bookkeeping<br>• INFO ordering<br>• Alias IDs<br>• Fragment scripts and their properties<br>• Object bounds on save<br>• ITM cleaning on save<br>• SEQ files<br>• Strings files<br>• ESL eligibility check and FormID compaction<br>• Backups before every write<br>• Undo/redo for everything |
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
```

## Layout

- `packages/esp`: plugin format, record schemas, conditions, VMAD, navmesh codec
- `packages/cleaner`: ITM/UDR cleaning
- `packages/papyrus`: Papyrus parser, checker, language service, fragment scripts, compiler driver
- `packages/assets`: BSA (zlib/LZ4), NIF geometry, DDS, FaceGen TRI
- `packages/navmesh`: navmesh generation (Recast), linking, validation
- `packages/workspace`: the editing engine (load order, MO2, virtual file system, edits/undo, services, automations, demo data)
- `packages/cli`: the `tes5` command-line tool
- `apps/studio`: the desktop/web editor (React, three.js, Monaco, Electron)

[ARCHITECTURE.md](ARCHITECTURE.md) explains how the pieces fit together.

## Disclaimer

This is an independent community tool, not affiliated with or endorsed by Bethesda. Keep backups of your plugins; the editor writes a backup before overwriting any file, but it is young software.
