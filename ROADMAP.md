# Roadmap and honest status

Legend: ✅ working and tested · 🟡 partial / limited · ❌ not implemented yet

Tested means unit tests (`npm test`) plus the Playwright run of the browser demo (`npm run test:e2e`). **Nothing has been verified yet against a real Skyrim.esm load order or in-game.** That is the most important next step.

## Status against the Creation Kit

| Feature | Status | Notes |
| --- | --- | --- |
| Read/write ESM/ESP/ESL, compressed records, localized strings | ✅ | Lossless round-trip is checked before a record can be edited. |
| Record coverage | 🟡 | Full schemas for the main quest/NPC/world/item types. Others show a raw field list and are preserved exactly, but aren't editable as forms. |
| Load order, plugins.txt, MO2 instances/profiles, BSA + loose VFS | ✅ | Real MO2 setups are untested. |
| Undo/redo, auto masters, backups, atomic saves | ✅ | |
| ITM / UDR cleaning (Quick Auto Clean) | ✅ | Safe and xEdit modes. Deleted-navmesh repair is experimental. |
| 3D viewport, Blender controls, drag & drop placement | ✅ | Static meshes only. Actors show as capsules; skinned bodies and armour aren't rendered. |
| Rendering fidelity | 🟡 | Diffuse textures and alpha are supported. Normal/specular maps, LOD, water, sky and weather are not. |
| Exterior terrain (LAND) | 🟡 | Heights and vertex colours are shown. Texture layers and terrain editing are not. |
| Navmesh generation, door linking, exterior stitching | 🟡 | Works on the demo. The NVNM grid cell ordering and triangle winding rules are inferred from xEdit and need in-game confirmation, which is why the grid divisor defaults to 1. Cover data isn't generated. |
| World tools (paint, paths, arrays, drop, kit snapping, lighting pass, moods, clutter, room builder, linked doors) | 🟡 | They use the cell's real geometry, so they work on any mesh. Some parts rely on guesses that need checking against vanilla content:<br>• clutter themes and the lighting pass find items by Editor ID keywords;<br>• kit pieces are assumed to have their long side on the X axis (there's a turn setting if not);<br>• a door's arrival point goes on the side with floor and open space.<br>The mood presets are hand-picked colours, not copied from vanilla lighting templates. |
| Navmesh manual editing | ✅ | Tab enters edit mode, with Blender-style select / box / all. You can draw triangles (click 3 points, snapping to existing vertices, continuing as a strip), move vertices with G and X/Y/Z axis locks, delete triangles, and set the preferred / water / no-large-creatures flags. Edge links inside the mesh and the search grid are rebuilt after each edit. |
| Character creator | 🟡 | Head parts, sliders, colours and tints are edited correctly. The preview uses the race-agnostic chargen morph names, so check them against real head TRIs. **FaceGen export (Ctrl+F4) is not implemented**: the editor detects missing FaceGen and tells you to export it from the CK. |
| Quests: stages, objectives, aliases, fragments | ✅ | Alias fill types beyond unique actor, specific reference and location must be set in the properties panel. |
| Dialogue: topics, responses, conditions, begin/end scripts, voice names | ✅ | Scenes (SCEN) and packages (PACK) are only partly supported (raw fields). The voice-file truncation rule matches community documentation and should be confirmed. |
| Quest map (stages connected by what advances them) | ✅ | Connections are stored as ordinary dialogue, alias scripts and stage fragments, so the CK and xEdit see normal data. Stage changes made by hand-written scripts are only shown when they're a literal `SetStage(N)`. |
| Visual triggers and templates | 🟡 | Generates Papyrus with a marker line so it can be read back; hand edits to a generated script are overwritten the next time its triggers are saved in the visual editor. Compiles cleanly with the built-in checker, but in-game behaviour of every action hasn't been tried. |
| Dialogue graph and screenplay import | ✅ | Speakers are matched by NPC name or Editor ID. |
| Test in game | 🟡 | The batch file and console commands are standard. Starting the game through MO2 uses `ModOrganizer.exe -p <profile> moshortcut://:<executable>`, which is untested here, as is launching from the desktop app in general. |
| SEQ files | 🟡 | Generated for start-game-enabled quests that own dialogue. The exact inclusion criteria should be confirmed against the CK. |
| Papyrus editor and language service | ✅ | Built-in stubs cover the core API types. Full vanilla sources (Scripts.zip) give complete checking. |
| Compiling scripts | 🟡 | Drives PapyrusCompiler.exe or Caprica. Tested with a fake runner only, since no compiler is available in CI. |
| Precombines/previs, LOD generation, Havok collision authoring, lip-sync generation | ❌ | Out of scope for now; use the CK or dedicated tools. |
| Packaging (Windows installer) | 🟡 | electron-builder is configured; no signed build has been produced yet. |

## Performance at Skyrim.esm scale

`npm run bench` generates a synthetic master with about 915k records and groups (65 MB) and times the editor's operations. Typical results in the development container:

| Operation | Time |
| --- | --- |
| Load the plugin | ~0.7 s |
| Build lookup indexes once after loading | ~1.7 s |
| Search a record type (each keystroke) | 20–50 ms |
| List all cells | ~60 ms |
| Open a cell's references | <5 ms |
| Edit, place, undo or save a small plugin | <5 ms each |
| List every record with no filter, sorted | ~0.6 s |

- Edits never rebuild the indexes: the plugin being edited is merged in at query time.
- Memory after loading is about 0.5 GB of heap.
- The real Skyrim.esm is about 4× larger on disk, mostly because of compressed records, so expect parsing to take a few seconds. This hasn't been measured with the real file.

## Known uncertainties to verify in game

1. **Rotations:** the reference rotation convention (clockwise, applied Z·Y·X) is used consistently by the viewport, bounds and navmesh. It should still be checked by placing an asymmetric object and comparing with the CK.
2. **NVNM:** the grid ordering and the walkable-side winding.
3. **Chargen TRIs:** the morph names in real chargen TRI files (`CHARGEN_SLIDER_MORPHS`).
4. **Voice files:** the file-name truncation rule.
5. **SEQ:** which quests must be listed in the SEQ file.
6. **Generated trigger scripts:** each trigger action in game (especially `movePlayerTo`, `lock` and `arrive` via OnCellAttach).
7. **MO2 launch:** the `moshortcut://` argument form and the profile switch.
8. **Linked doors:** that arrival points land on the correct side for vanilla door meshes, and that the generated light forms (radius, flicker) look right in game.

## Next steps

1. Open a vanilla Skyrim SE install and a large MO2 setup. Confirm the synthetic benchmark numbers hold, then verify that saving unchanged plugins produces identical files.
2. FaceGen export: bake head meshes with morphs and write the facetint DDS.
3. Render skinned actors and armour; add normal maps.
4. Navmesh cover generation, and merging or splitting vertices.
5. Scene (SCEN) and AI package editors.
