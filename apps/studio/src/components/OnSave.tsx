/** The "every time you save" options; shown on the Automations tab and in Settings. */
import { Checkbox } from './ui';
import { useStore } from '../state/store';

export function OnSave() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  return (
    <div className="card" data-testid="on-save">
      <div className="card-title">Every time you save</div>
      <div className="col" style={{ gap: 6 }}>
        <Checkbox
          checked={settings.autoCleanOnSave}
          onChange={(autoCleanOnSave) => update({ autoCleanOnSave })}
          label="Remove records identical to their master (no dirty edits)"
          help="The Creation Kit copies records into your plugin just because you looked at them. Those 'dirty edits' change nothing but can undo other mods' changes. They're removed, like xEdit's Quick Auto Clean, keeping deliberate reverts."
        />
        <Checkbox
          checked={settings.updateBoundsOnSave}
          onChange={(updateBoundsOnSave) => update({ updateBoundsOnSave })}
          label="Recalculate object bounds from their meshes"
          help="Every placeable object has a bounding box the game uses to decide when it's visible and for placement. When you change an object's mesh, its box is measured again so things don't pop in and out of view."
        />
        <Checkbox
          checked={settings.generateSeqOnSave}
          onChange={(generateSeqOnSave) => update({ generateSeqOnSave })}
          label="Write the SEQ file for start-game-enabled quests with dialogue"
          help="Quests that run from the start of the game and have dialogue need a .seq file, or their dialogue won't show up until the game is restarted. The Creation Kit only writes it when you remember to ask."
        />
        <Checkbox
          checked={settings.generateFacesOnSave}
          onChange={(generateFacesOnSave) => update({ generateFacesOnSave })}
          label="Generate face files for characters whose look changed"
          help="Characters with a changed face need FaceGen files (a head mesh and a face tint) or they show the dark-face bug in game. They're baked from your sliders and paint and written next to your plugin, in place of the Creation Kit's Ctrl+F4. Only changed faces are rebuilt, and Undo removes them again."
        />
        <Checkbox
          checked={settings.autoCompileOnSave}
          onChange={(autoCompileOnSave) => update({ autoCompileOnSave })}
          label="Compile scripts that changed"
          help="The game only runs compiled scripts (.pex). Your scripts whose source is newer than their .pex are compiled with Caprica (free, comes with the app) when you save the plugin or the script. Errors are listed after saving; the save itself always goes through. Set up compiling in the Scripts tab."
        />
      </div>
    </div>
  );
}
