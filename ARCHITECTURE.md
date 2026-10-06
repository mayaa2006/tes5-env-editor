# Architecture

```
apps/studio (React UI) ──EngineClient──▶ HostBridge ──▶ EngineHost ──▶ @tes5/workspace
                                             │                            │
            Electron: IPC → worker thread ◀──┘                            ├─ @tes5/esp       (plugins, schemas)
            Browser demo: in-page, in-memory FS                           ├─ @tes5/cleaner
                                                                          ├─ @tes5/papyrus
                                                                          ├─ @tes5/assets    (BSA/NIF/DDS/TRI)
                                                                          └─ @tes5/navmesh   (Recast)
```

## Principles

- **The engine owns the data; the UI only describes intent.** Every UI action is a single RPC call such as `placeReference`, `setStageFragment` or `generateNavmesh`. The engine does all the bookkeeping that the Creation Kit leaves to the user. It runs in a worker thread in Electron, and in-page in the browser demo.
- **FormKeys, not FormIDs.** Above the file format, forms are identified as `"012E49:Skyrim.esm"`. The engine translates to file-local IDs on write, and adds or remaps masters as needed. This removes a whole class of load-order bugs.
- **Lossless round-trips.** Records decode through a declarative schema into plain data. When typed data is applied back:
  - unknown subrecords are kept, in their original order;
  - truncated structs keep their tail bytes.

  Before a record can be edited, it is decoded and re-encoded raw and compared byte for byte. Records that don't round-trip stay read-only in the form editor.
- **Undo by snapshot.** Each transaction snapshots the plugin bytes it touched. Nested transactions fold into one undo step, so a compound action ("Duplicate 5 references") undoes in one step.
- **Safe by default:**
  - Deleting a master reference disables it instead (deleted references crash the game).
  - Saving cleans ITMs, writes atomically and keeps a backup.

## Packages

### `@tes5/esp`
Covers the binary plugin format, from top-level group (GRUP) layout down to subrecords and their size and compression handling.

The schema DSL in `schema/dsl.ts` describes each record type. Some types are fully covered (NPC_, QUST, INFO, DIAL, CELL, REFR, WEAP and more); others are partial. The package also defines:

- the condition-function table (about 395 functions, generated from xEdit);
- VMAD, including fragments;
- the NVNM navmesh codec.

### `@tes5/cleaner`
ITM detection compares normalized subrecords. Order-insensitive lists are sorted first and known-volatile bytes are ignored. When layouts differ, it falls back to a typed comparison through FormKeys.

UDR fixing follows xEdit's rules:

- restore the record from its master;
- set it as initially disabled, enable-parented to the player with the opposite-state flag;
- move it to Z = -30000 when it isn't persistent.

### `@tes5/papyrus`
A fault-tolerant lexer and parser feed a type checker. The checker works over a script index of built-in stubs, game sources and your own sources. It reports "doesn't exist" errors only when the whole inheritance chain is known, so missing vanilla sources never produce false errors.

The language service provides diagnostics, completion, hover, signature help and an outline. `fragments.ts` generates and parses CK-compatible `QF_` / `TIF_` / `PF_` / `SF_` / `PRKF_` scripts.

### `@tes5/assets`
- BSA v104 (zlib) and v105 (LZ4 frame) archives, read and write; LZ4 output is verified against liblz4.
- NIF 20.2.0.7 geometry from both LE and SE meshes:
  - shape types: NiTriShape and BSTriShape;
  - materials: lighting/effect shaders, texture sets and alpha.
- DDS images, with software decoding of BC1–5.
- FaceGen TRI morph files.

### `@tes5/navmesh`
Generation runs these steps:

1. Collect world-space triangles from the cell's static meshes and its LAND terrain.
2. Run Recast to get a walkable surface.
3. Build the NVNM structures: adjacency and the search grid.
4. Link doors, and connect exterior edges to neighbouring cells.
5. Validate the result.

### `@tes5/workspace`
- **Loading:** reads load orders (plugins.txt, MO2 profiles) and builds a virtual Data folder (loose files override archives; mod priority applies).
- **`Workspace`:** load, edit, undo, save. On save it runs pre/post-save hooks: ITM cleaning, SEQ file, strings files and backups.
- **Services:** `WorldService`, `NpcService`, `QuestService` and `ScriptService`.
- **Automations:** ESL checks, FormID compaction, bounds, navmesh generation.
- **Demo:** a procedurally generated demo data set built with this repository's own writers. No Bethesda content is included.

### `apps/studio`
React 19 + zustand UI.

- `engine/host.ts` is the full RPC surface.
- The 3D viewport (`views/scene/viewport.ts`) is a framework-free controller around three.js. It implements Blender's modal transform model.
- The NPC preview applies TRI chargen morphs to head-part meshes.
- Monaco provides Papyrus editing; its language features call back into the engine.
- Electron:
  - `electron/main.ts` creates the window and forwards IPC;
  - `electron/engine-worker.ts` runs the engine with real file access;
  - `electron/preload.ts` exposes a four-function bridge to the page.
