/**
 * A small, entirely synthetic data set ("DemoWorld.esm") used by the browser
 * demo of the Studio and by tests. It contains no Bethesda content: meshes,
 * textures and records are generated here.
 */
import { CHARGEN_SLIDER_MORPHS, writeNif, writeOsd, writeRgbaDds, writeTri, type ShapeDiff } from '@tes5/assets';
import {
  Plugin,
  PluginRecord,
  RecordFlags,
  VmadPropertyType,
  applyTyped,
  newCondition,
  conditionFunctionByName,
  placeRecord,
  type PlaceOptions,
} from '@tes5/esp';
import type { MemoryFileSystem } from '../fs';
import { box, cylinder, ellipsoid, merge, shape, stairs, terrain, translate, type MeshData } from './meshes';

export interface DemoPaths {
  gameDir: string;
  dataDir: string;
  plugins: string[];
}

const T = (name: string) => `textures\\demo\\${name}.dds`;

function texture(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y);
      px.set([r, g, b, a], (y * w + x) * 4);
    }
  return writeRgbaDds(w, h, px);
}

function noise(x: number, y: number, s = 1): number {
  const n = Math.sin(x * 12.9898 * s + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

const TEXTURES: Record<string, Uint8Array> = {
  wood: texture(64, 64, (x, y) => {
    const v = 0.75 + 0.25 * Math.sin(x / 2 + Math.sin(y / 9) * 3) - noise(x, y) * 0.1;
    return [Math.round(120 * v), Math.round(80 * v), Math.round(45 * v), 255];
  }),
  stone: texture(64, 64, (x, y) => {
    const mortar = x % 32 < 2 || (y + (Math.floor(x / 32) % 2) * 16) % 32 < 2;
    const v = mortar ? 0.45 : 0.7 + noise(x, y) * 0.2;
    return [Math.round(140 * v), Math.round(138 * v), Math.round(130 * v), 255];
  }),
  plaster: texture(32, 32, (x, y) => {
    const v = 0.85 + noise(x, y) * 0.1;
    return [Math.round(220 * v), Math.round(205 * v), Math.round(175 * v), 255];
  }),
  metal: texture(32, 32, (x, y) => {
    const v = 0.6 + noise(x, y, 3) * 0.15;
    return [Math.round(150 * v), Math.round(150 * v), Math.round(160 * v), 255];
  }),
  grass: texture(64, 64, (x, y) => {
    const v = 0.7 + noise(x, y) * 0.3;
    return [Math.round(70 * v), Math.round(110 * v), Math.round(50 * v), 255];
  }),
  rock: texture(64, 64, (x, y) => {
    const v = 0.55 + noise(x, y, 2) * 0.35;
    return [Math.round(115 * v), Math.round(110 * v), Math.round(105 * v), 255];
  }),
  skin: texture(32, 32, (x, y) => {
    const v = 0.95 + noise(x, y) * 0.05;
    return [Math.round(225 * v), Math.round(180 * v), Math.round(150 * v), 255];
  }),
  hair: texture(32, 32, (x, y) => {
    const v = 0.6 + 0.4 * Math.abs(Math.sin(x * 1.3 + noise(x, y)));
    return [Math.round(255 * v), Math.round(255 * v), Math.round(255 * v), 255];
  }),
  eyes: texture(32, 32, (x, y) => {
    const d = Math.hypot(x - 16, y - 16);
    if (d < 4) return [10, 10, 10, 255];
    if (d < 10) return [90, 60, 30, 255];
    return [240, 240, 235, 255];
  }),
  fabric: texture(32, 32, (x, y) => {
    const v = (x + y) % 4 < 2 ? 0.8 : 0.7;
    return [Math.round(130 * v), Math.round(40 * v), Math.round(40 * v), 255];
  }),
  marker: texture(8, 8, () => [255, 80, 200, 255]),
};

/** Demo race tint masks, in the head's UV space (u around from +x, v down from the crown; the face is at u≈0.25). */
const blob = (u: number, v: number, cu: number, cv: number, ru: number, rv: number) => Math.max(0, 1 - Math.hypot((u - cu) / ru, (v - cv) / rv));
const mask = (fn: (u: number, v: number) => number) =>
  texture(64, 64, (x, y) => {
    const g = Math.round(Math.max(0, Math.min(1, fn((x + 0.5) / 64, (y + 0.5) / 64))) * 255);
    return [g, g, g, 255];
  });
export const DEMO_TINT_MASKS: { index: number; file: string; type: number; dds: Uint8Array }[] = [
  { index: 1, file: 'SkinTone', type: 6, dds: mask(() => 1) },
  { index: 2, file: 'Cheeks', type: 2, dds: mask((u, v) => Math.min(1, 1.6 * Math.max(blob(u, v, 0.14, 0.53, 0.07, 0.08), blob(u, v, 0.36, 0.53, 0.07, 0.08)))) },
  { index: 3, file: 'Lips', type: 1, dds: mask((u, v) => Math.min(1, 2 * blob(u, v, 0.25, 0.61, 0.05, 0.025))) },
  { index: 4, file: 'EyeSocketUpper', type: 4, dds: mask((u, v) => Math.min(1, 1.8 * Math.max(blob(u, v, 0.19, 0.4, 0.04, 0.03), blob(u, v, 0.31, 0.4, 0.04, 0.03)))) },
  { index: 5, file: 'Warpaint01', type: 9, dds: mask((u, v) => (Math.abs(u - 0.19) < 0.018 && v > 0.33 && v < 0.62 ? 1 : 0)) },
];

function nif(...shapes: Parameters<typeof shape>[]): Uint8Array {
  return writeNif(
    shapes.map((s) => shape(...s)),
    { game: 'SkyrimSE' },
  );
}

/** The head used by both sexes, with chargen morphs for every slider. */
function headMesh(female: boolean): { mesh: MeshData; tri: Uint8Array } {
  const m = ellipsoid(female ? 9.5 : 10.5, female ? 11 : 12, female ? 13 : 14, 120, 18, 28);
  const p = m.positions;
  const n = p.length / 3;
  const region = (fn: (x: number, y: number, z: number) => [number, number, number]) => {
    const d = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const [dx, dy, dz] = fn(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]! - 120);
      d[i * 3] = dx;
      d[i * 3 + 1] = dy;
      d[i * 3 + 2] = dz;
    }
    return d;
  };
  const near = (x: number, y: number, z: number, cx: number, cy: number, cz: number, r: number) => Math.max(0, 1 - Math.hypot(x - cx, y - cy, z - cz) / r);
  const front = (y: number) => (y > 0 ? 1 : 0);
  const effects: Record<string, (x: number, y: number, z: number) => [number, number, number]> = {
    NoseShort: (x, y, z) => [0, -2.5 * near(x, y, z, 0, 12, 0, 6), 0],
    NoseLong: (x, y, z) => [0, 3 * near(x, y, z, 0, 12, 0, 6), 0],
    NoseUp: (x, y, z) => [0, 0, 2 * near(x, y, z, 0, 12, 0, 6)],
    NoseDown: (x, y, z) => [0, 0, -2 * near(x, y, z, 0, 12, 0, 6)],
    JawUp: (x, y, z) => [0, 0, z < -6 ? 2 : 0],
    JawDown: (x, y, z) => [0, 0, z < -6 ? -2.5 : 0],
    JawWide: (x, _y, z) => [z < -4 ? Math.sign(x) * 2 : 0, 0, 0],
    JawNarrow: (x, _y, z) => [z < -4 ? -Math.sign(x) * 1.5 : 0, 0, 0],
    JawForward: (_x, y, z) => [0, z < -6 && y > 0 ? 2 : 0, 0],
    JawBack: (_x, y, z) => [0, z < -6 && y > 0 ? -2 : 0, 0],
    CheeksUp: (x, y, z) => [0, 0, 1.5 * near(Math.abs(x), y, z, 7, 8, -1, 5)],
    CheeksDown: (x, y, z) => [0, 0, -1.5 * near(Math.abs(x), y, z, 7, 8, -1, 5)],
    CheeksOut: (x, y, z) => [0, 1.5 * near(Math.abs(x), y, z, 7, 8, -1, 5), 0],
    CheeksIn: (x, y, z) => [0, -1.5 * near(Math.abs(x), y, z, 7, 8, -1, 5), 0],
    EyesMoveUp: (x, y, z) => [0, 0, 1.2 * near(Math.abs(x), y, z, 4, 10, 3, 4)],
    EyesMoveDown: (x, y, z) => [0, 0, -1.2 * near(Math.abs(x), y, z, 4, 10, 3, 4)],
    EyesMoveIn: (x, y, z) => [-Math.sign(x) * near(Math.abs(x), y, z, 4, 10, 3, 4), 0, 0],
    EyesMoveOut: (x, y, z) => [Math.sign(x) * near(Math.abs(x), y, z, 4, 10, 3, 4), 0, 0],
    EyesForward: (x, y, z) => [0, near(Math.abs(x), y, z, 4, 10, 3, 4), 0],
    EyesBack: (x, y, z) => [0, -near(Math.abs(x), y, z, 4, 10, 3, 4), 0],
    BrowUp: (x, y, z) => [0, 0, 1.5 * near(Math.abs(x), y, z, 4, 10, 6, 4)],
    BrowDown: (x, y, z) => [0, 0, -1.5 * near(Math.abs(x), y, z, 4, 10, 6, 4)],
    BrowIn: (x, y, z) => [-Math.sign(x) * near(Math.abs(x), y, z, 4, 10, 6, 4), 0, 0],
    BrowOut: (x, y, z) => [Math.sign(x) * near(Math.abs(x), y, z, 4, 10, 6, 4), 0, 0],
    BrowForward: (x, y, z) => [0, 1.5 * near(Math.abs(x), y, z, 4, 10, 6, 4), 0],
    BrowBack: (x, y, z) => [0, -1.5 * near(Math.abs(x), y, z, 4, 10, 6, 4), 0],
    LipMoveUp: (x, y, z) => [0, 0, near(x, y, z, 0, 11, -5, 4)],
    LipMoveDown: (x, y, z) => [0, 0, -near(x, y, z, 0, 11, -5, 4)],
    LipMoveIn: (x, y, z) => [0, -near(x, y, z, 0, 11, -5, 4), 0],
    LipMoveOut: (x, y, z) => [0, near(x, y, z, 0, 11, -5, 4), 0],
    ChinThin: (x, y, z) => [-Math.sign(x) * near(x, y, z, 0, 9, -11, 5), 0, 0],
    ChinWide: (x, y, z) => [Math.sign(x) * 1.5 * near(x, y, z, 0, 9, -11, 5), 0, 0],
    ChinMoveUp: (x, y, z) => [0, 0, near(x, y, z, 0, 9, -11, 5)],
    ChinMoveDown: (x, y, z) => [0, 0, -1.5 * near(x, y, z, 0, 9, -11, 5)],
    Overbite: (x, y, z) => [0, front(y) * near(x, y, z, 0, 11, -7, 4), 0],
    Underbite: (x, y, z) => [0, front(y) * near(x, y, z, 0, 10, -9, 4), 0],
    VampireMorph: (x, y, z) => [0, 0, -0.5 * near(x, y, z, 0, 0, 0, 12)],
    // Extra morphs, like the ones RaceMenu morph packs add (shown as "More shapes").
    NoseHooked: (x, y, z) => [0, 1.2 * near(x, y, z, 0, 12, 2, 3), -0.8 * near(x, y, z, 0, 12, -1, 3)],
    EarsPointed: (x, _y, z) => [Math.sign(x) * 2 * near(Math.abs(x), 0, z, 10.5, 0, 2, 4), 0, 2.5 * near(Math.abs(x), 0, z, 10.5, 0, 2, 4)],
    LipsFull: (x, y, z) => [0, 0.9 * near(x, y, z, 0, 11, -5, 3), 0.3 * Math.sign(z + 5) * near(x, y, z, 0, 11, -5, 3)],
    CheekbonesHigh: (x, y, z) => [Math.sign(x) * 0.8 * near(Math.abs(x), y, z, 8, 6, 1, 4), 0.6 * near(Math.abs(x), y, z, 8, 6, 1, 4), 0],
  };
  const morphs = [...CHARGEN_SLIDER_MORPHS.flat(), 'NoseHooked', 'EarsPointed', 'LipsFull', 'CheekbonesHigh']
    .filter((n) => n && effects[n])
    .map((name) => ({ name, deltas: region(effects[name]!) }));
  const tri = writeTri({ vertices: new Float32Array(m.positions), triangles: new Uint32Array(m.indices), uvs: new Float32Array(m.uvs), morphs });
  return { mesh: m, tri };
}

function meshesAndTextures(): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const [name, dds] of Object.entries(TEXTURES)) files[T(name)] = dds;
  files['meshes\\demo\\floor.nif'] = nif(['Floor', box(-128, -128, -8, 128, 128, 0), [T('wood')]]);
  files['meshes\\demo\\wall.nif'] = nif(['Wall', box(-128, -8, 0, 128, 8, 256), [T('plaster')]]);
  files['meshes\\demo\\crate.nif'] = nif(['Crate', box(-24, -24, 0, 24, 24, 48, 1 / 48), [T('wood')]]);
  files['meshes\\demo\\barrel.nif'] = nif(['Barrel', cylinder(20, 56, 16), [T('wood')]]);
  files['meshes\\demo\\pillar.nif'] = nif(['Pillar', merge(box(-20, -20, 0, 20, 20, 16), cylinder(14, 224, 12, 16), box(-20, -20, 240, 20, 20, 256)), [T('stone')]]);
  files['meshes\\demo\\table.nif'] = nif(['Table', merge(box(-60, -36, 70, 60, 36, 78), box(-56, -32, 0, -48, -24, 70), box(48, -32, 0, 56, -24, 70), box(-56, 24, 0, -48, 32, 70), box(48, 24, 0, 56, 32, 70)), [T('wood')]]);
  files['meshes\\demo\\stairs.nif'] = nif(['Stairs', stairs(128, 256, 128, 8), [T('stone')]]);
  files['meshes\\demo\\rock.nif'] = nif(['Rock', ellipsoid(90, 70, 50, 20, 8, 12), [T('rock')]]);
  files['meshes\\demo\\door.nif'] = nif(['Door', box(-48, -6, 0, 48, 6, 160, 1 / 96), [T('wood')]], ['Frame', merge(box(-56, -10, 0, -48, 10, 168), box(48, -10, 0, 56, 10, 168), box(-56, -10, 160, 56, 10, 168)), [T('stone')]]);
  files['meshes\\demo\\chest.nif'] = nif(['Chest', merge(box(-40, -24, 0, 40, 24, 40), box(-41, -25, 40, 41, 25, 52)), [T('wood')]]);
  files['meshes\\demo\\torch.nif'] = nif(['Torch', cylinder(3, 40, 8), [T('wood')]], ['Flame', translate(ellipsoid(5, 5, 9, 0, 6, 8), 0, 0, 46), [T('marker')], { alphaBlend: true }]);
  files['meshes\\demo\\xmarker.nif'] = nif(['Marker', box(-8, -8, 0, 8, 8, 16), [T('marker')]]);
  files['meshes\\demo\\tankard.nif'] = nif(['Tankard', cylinder(4, 10, 12), [T('wood')]]);
  files['meshes\\demo\\plate.nif'] = nif(['Plate', cylinder(8, 1.5, 16), [T('stone')]]);
  files['meshes\\demo\\bowl.nif'] = nif(['Bowl', cylinder(6, 4, 12), [T('wood')]]);
  files['meshes\\demo\\bottle.nif'] = nif(['Bottle', merge(cylinder(3, 10, 10), cylinder(1.2, 4, 8, 10)), [T('marker')]]);
  files['meshes\\demo\\sack.nif'] = nif(['Sack', ellipsoid(14, 10, 11, 11, 8, 12), [T('fabric')]]);
  files['meshes\\demo\\candle.nif'] = nif(['Candle', cylinder(2, 12, 8), [T('fabric')]], ['Flame', translate(ellipsoid(1.2, 1.2, 2.5, 0, 6, 8), 0, 0, 14), [T('marker')], { alphaBlend: true }]);
  files['meshes\\demo\\brazier.nif'] = nif(['Brazier', merge(cylinder(24, 8, 16, 30), box(-3, -3, 0, 3, 3, 30)), [T('stone')]], ['Fire', translate(ellipsoid(14, 14, 10, 0, 6, 10), 0, 0, 40), [T('marker')], { alphaBlend: true }]);
  files['meshes\\demo\\bush.nif'] = nif(['Bush', ellipsoid(40, 40, 25, 25, 8, 12), [T('grass')]]);
  files['meshes\\demo\\fern.nif'] = nif(['Fern', ellipsoid(20, 20, 9, 9, 6, 10), [T('grass')]]);
  files['meshes\\demo\\wallcorner.nif'] = nif(['WallCorner', box(-12, -12, 0, 12, 12, 256), [T('plaster')]]);
  files['meshes\\demo\\walldoorway.nif'] = nif(['WallDoorway', merge(box(-128, -8, 0, -48, 8, 256), box(48, -8, 0, 128, 8, 256), box(-48, -8, 192, 48, 8, 256)), [T('plaster')]]);
  files['meshes\\demo\\road.nif'] = nif(['Road', box(-128, -64, 0, 128, 64, 2, 1 / 128), [T('stone')]]);
  files['meshes\\demo\\fence.nif'] = nif(['Fence', merge(box(-64, -4, 0, -58, 4, 60), box(58, -4, 0, 64, 4, 60), box(-64, -2, 20, 64, 2, 26), box(-64, -2, 44, 64, 2, 50)), [T('wood')]]);
  files['meshes\\demo\\ground.nif'] = nif(['Ground', terrain(4096, 16, 60), [T('grass')]]);
  const male = headMesh(false);
  const female = headMesh(true);
  for (const m of DEMO_TINT_MASKS) files[`textures\\demo\\tintmasks\\${m.file.toLowerCase()}.dds`] = m.dds;
  files['meshes\\demo\\head_male.nif'] = nif(['MaleHead', male.mesh, [T('skin')]]);
  files['meshes\\demo\\head_male_chargen.tri'] = male.tri;
  files['meshes\\demo\\head_female.nif'] = nif(['FemaleHead', female.mesh, [T('skin')]]);
  files['meshes\\demo\\head_female_chargen.tri'] = female.tri;
  files['meshes\\demo\\hair_short.nif'] = nif(['HairShort', translate(ellipsoid(11, 12.5, 9, 0, 10, 20), 0, -1, 126), [T('hair')]]);
  files['meshes\\demo\\hair_long.nif'] = nif(['HairLong', merge(translate(ellipsoid(11.5, 13, 10, 0, 10, 20), 0, -1.5, 126), box(-10, -14, 96, 10, -6, 124)), [T('hair')]]);
  files['meshes\\demo\\beard.nif'] = nif(['Beard', translate(ellipsoid(8, 5, 6, 0, 8, 12), 0, 9, 108), [T('hair')]]);
  files['meshes\\demo\\eyes.nif'] = nif(['Eyes', merge(translate(ellipsoid(2, 2, 2, 0, 6, 8), -4, 10, 123), translate(ellipsoid(2, 2, 2, 0, 6, 8), 4, 10, 123)), [T('eyes')]]);
  files['meshes\\demo\\brows.nif'] = nif(['Brows', merge(box(-7, 10.5, 126, -1.5, 12, 127), box(1.5, 10.5, 126, 7, 12, 127)), [T('hair')]]);
  files['meshes\\demo\\body.nif'] = nif(['Body', merge(cylinder(16, 60, 12, 0), translate(cylinder(18, 46, 12), 0, 0, 60), translate(cylinder(6, 8, 8), 0, 0, 106)), [T('fabric')]]);
  return files;
}

const SCRIPTS: Record<string, string> = {
  DemoQuestScript: `Scriptname DemoQuestScript extends Quest
{Tracks the tavern quest.}

GlobalVariable Property DemoGoldReward Auto
ReferenceAlias Property Alias_Innkeeper Auto

Function GiveReward()
  Game.GetPlayer().AddItem(Game.GetForm(0x0000000F), DemoGoldReward.GetValueInt())
EndFunction
`,
  DemoChestScript: `Scriptname DemoChestScript extends ObjectReference

Message Property DemoWelcomeMsg Auto

Event OnActivate(ObjectReference akActionRef)
  If akActionRef == Game.GetPlayer()
    DemoWelcomeMsg.Show()
  EndIf
EndEvent
`,
};

function posRot(x: number, y: number, z: number, rz = 0) {
  return { position: { x, y, z }, rotation: { x: 0, y: 0, z: rz } };
}

/** LAND for a demo exterior cell: rolling hills that match the ground mesh's style. */
function landData(gx: number, gy: number): Record<string, unknown> {
  const h = (x: number, y: number) => 60 * (Math.sin((x + 37) / 600) * Math.cos((y - 13) / 500) + 0.3 * Math.sin((x * 1.7 + y) / 260));
  const H: number[] = [];
  for (let r = 0; r < 33; r++) for (let c = 0; c < 33; c++) H.push(Math.round(h(gx * 4096 + c * 128, gy * 4096 + r * 128) / 8));
  const vhgt = new Uint8Array(4 + 33 * 33 + 3);
  const dv = new DataView(vhgt.buffer);
  dv.setFloat32(0, H[0]!, true);
  for (let r = 0; r < 33; r++)
    for (let c = 0; c < 33; c++) {
      const prev = c > 0 ? H[r * 33 + c - 1]! : r > 0 ? H[(r - 1) * 33]! : H[0]!;
      dv.setInt8(4 + r * 33 + c, H[r * 33 + c]! - prev);
    }
  const vclr = new Uint8Array(33 * 33 * 3);
  for (let i = 0; i < 33 * 33; i++) {
    const t = 0.85 + 0.15 * Math.sin(i * 0.37);
    vclr.set([Math.round(200 * t), Math.round(230 * t), Math.round(180 * t)], i * 3);
  }
  return { flags: 0x1 | 0x2, heights: vhgt, colors: vclr };
}

function rec(p: Plugin, sig: string, id: number, data: Record<string, unknown>, where: PlaceOptions = {}, flags = 0): number {
  const r = PluginRecord.create(sig, id, [], flags);
  applyTyped(r, data);
  placeRecord(p, r, where);
  return id;
}

function buildDemoMaster(): Plugin {
  const p = Plugin.create('DemoWorld.esm', { author: 'tes5-env-editor', description: 'Synthetic demo data (no Bethesda content).' });
  let next = 0x800;
  const id = () => next++;
  const model = (file: string) => ({ file });
  const bounds = (x: number, y: number, z: number) => ({ x1: -x, y1: -y, z1: 0, x2: x, y2: y, z2: z });
  const dirMat = { maxAngle: 90, material: 0, consideredSnow: 0, unused: new Uint8Array(3) };

  const kwNpc = rec(p, 'KYWD', id(), { editorId: 'ActorTypeNPC', color: { r: 0, g: 0, b: 0, a: 0 } });
  const vMale = rec(p, 'VTYP', id(), { editorId: 'MaleCommoner', flags: 1 });
  const vFemale = rec(p, 'VTYP', id(), { editorId: 'FemaleCommoner', flags: 1 | 2 });
  const hairBrown = rec(p, 'CLFM', id(), { editorId: 'HairColorBrown', name: 'Brown', color: { r: 92, g: 60, b: 38, a: 0 }, playable: 1 });
  rec(p, 'CLFM', id(), { editorId: 'HairColorBlonde', name: 'Blonde', color: { r: 214, g: 180, b: 110, a: 0 }, playable: 1 });
  const hairBlack = rec(p, 'CLFM', id(), { editorId: 'HairColorBlack', name: 'Black', color: { r: 25, g: 22, b: 20, a: 0 }, playable: 1 });
  rec(p, 'CLFM', id(), { editorId: 'HairColorRed', name: 'Red', color: { r: 140, g: 50, b: 25, a: 0 }, playable: 1 });
  const raceId = 0x900;
  const validRaces = rec(p, 'FLST', id(), { editorId: 'HeadPartsDemoHuman', forms: [raceId] });
  const hp = (edid: string, name: string, type: number, flags: number, file: string, chargen?: string) =>
    rec(p, 'HDPT', id(), {
      editorId: edid,
      name,
      model: model(file),
      flags,
      type,
      parts: chargen ? [{ type: 2, file: chargen }] : [],
      validRaces,
    });
  const headM = hp('DemoHeadMale', 'Male Head', 1, 1 | 2, 'demo\\head_male.nif', 'demo\\head_male_chargen.tri');
  const headF = hp('DemoHeadFemale', 'Female Head', 1, 1 | 4, 'demo\\head_female.nif', 'demo\\head_female_chargen.tri');
  const hairShort = hp('DemoHairShort', 'Short Hair', 3, 1 | 2 | 4, 'demo\\hair_short.nif');
  const hairLong = hp('DemoHairLong', 'Long Hair', 3, 1 | 2 | 4, 'demo\\hair_long.nif');
  const eyes = hp('DemoEyesBrown', 'Brown Eyes', 2, 1 | 2 | 4, 'demo\\eyes.nif');
  const brows = hp('DemoBrows', 'Brows', 6, 1 | 2 | 4, 'demo\\brows.nif');
  const beard = hp('DemoBeardFull', 'Full Beard', 4, 1 | 2, 'demo\\beard.nif');
  const race = rec(p, 'RACE', raceId, { editorId: 'DemoHumanRace', name: 'Human', description: 'A sturdy demo people.', data: new Uint8Array(128) });
  {
    // Head data with tint masks for both sexes (only the parts FaceGen reads).
    const r = [...p.recordsOfType('RACE')].find((x) => x.formId === race)!;
    const u16 = (v: number) => new Uint8Array([v & 0xff, v >> 8]);
    const z = (t: string) => new TextEncoder().encode(`${t}\0`);
    for (const sex of ['MNAM', 'FNAM']) {
      r.subrecords.push({ sig: 'NAM0', data: new Uint8Array(0) }, { sig: sex, data: new Uint8Array(0) });
      // Default head and eyes, like vanilla races: characters only list what differs.
      const u32 = (v: number) => new Uint8Array(new Uint32Array([v]).buffer);
      [sex === 'MNAM' ? headM : headF, eyes].forEach((part, i) => r.subrecords.push({ sig: 'INDX', data: u32(i) }, { sig: 'HEAD', data: u32(part) }));
      for (const m of DEMO_TINT_MASKS) r.subrecords.push({ sig: 'TINI', data: u16(m.index) }, { sig: 'TINT', data: z(`demo\\tintmasks\\${m.file}.dds`) }, { sig: 'TINP', data: u16(m.type) });
    }
    r.markModified();
  }
  const cls = rec(p, 'CLAS', id(), {
    editorId: 'DemoWarriorClass',
    name: 'Warrior',
    description: 'Fights things.',
    data: { unknown: 0, teaches: -1, maxTrainingLevel: 0, skillWeights: new Array(18).fill(0), bleedoutDefault: 0.1, voicePoints: 0, healthWeight: 1, magickaWeight: 0, staminaWeight: 1, flags: 0 },
  });
  const faction = rec(p, 'FACT', id(), { editorId: 'DemoTownFaction', name: 'Townsfolk', relations: [], flags: 0 });
  const gold = rec(p, 'GLOB', id(), { editorId: 'DemoGoldReward', type: 115, value: 100 });
  const msg = rec(p, 'MESG', id(), { editorId: 'DemoWelcomeMsg', description: 'Welcome to the Demo Tavern!', icon: 0, flags: 1, displayTime: 2 });

  const skills = { values: new Array(18).fill(15), offsets: new Array(18).fill(0), health: 50, magicka: 0, stamina: 0, unused: new Uint8Array(2), farAwayDistance: 0, gearedUpWeapons: 0, unused2: new Uint8Array(3) };
  const npc = (edid: string, name: string, female: boolean, parts: number[], hair: number, morph: Record<string, number>, tone: [number, number, number]) =>
    rec(p, 'NPC_', id(), {
      editorId: edid,
      bounds: bounds(22, 14, 128),
      config: { flags: (female ? 1 : 0) | 0x20 | 0x2, magickaOffset: 0, staminaOffset: 0, level: 5, calcMinLevel: 1, calcMaxLevel: 0, speedMultiplier: 100, dispositionBase: 35, templateFlags: 0, healthOffset: 0, bleedoutOverride: 0 },
      factions: [{ faction, rank: 0, unused: new Uint8Array(3) }],
      voice: female ? vFemale : vMale,
      race,
      keywords: [kwNpc],
      class: cls,
      name,
      marker: true,
      skills,
      headParts: parts,
      hairColor: hair,
      unknownNAM5: new Uint8Array([0xff, 0x00]),
      height: 1,
      weight: 50,
      soundLevel: 1,
      textureLighting: { r: tone[0], g: tone[1], b: tone[2] },
      faceMorph: morph,
      faceParts: { nose: 0, unknown: -1, eyes: 0, mouth: 0 },
      tintLayers: [{ index: 1, color: { r: 230, g: 190, b: 160, a: 0 }, value: 100, preset: 0 }, ...(female ? [{ index: 3, color: { r: 170, g: 60, b: 70, a: 0 }, value: 60, preset: 0 }] : [])],
    });
  const smith = npc('DemoBlacksmith', 'Halvar the Smith', false, [headM, hairShort, eyes, brows, beard], hairBrown, { noseLongShort: -0.3, jawNarrowWide: 0.6, chinUnderbiteOverbite: 0.2 }, [0.85, 0.7, 0.6]);
  const keeper = npc('DemoInnkeeper', 'Brynja', true, [headF, hairLong, eyes, brows], hairBlack, { noseUpDown: 0.3, cheeksUpDown: 0.4, lipsInOut: 0.2 }, [0.9, 0.78, 0.7]);
  // Like vanilla characters: no head or eyes listed (the race's defaults are used), and the CK's FLT_MAX "unset" vampire slider.
  npc('DemoGuard', 'Town Guard', false, [hairShort, brows], hairBrown, { vampireMorph: 3.4028234663852886e38 }, [0.8, 0.65, 0.55]);

  const stat = (edid: string, file: string, b: [number, number, number], flags = 0) => rec(p, 'STAT', id(), { editorId: edid, bounds: bounds(...b), model: model(file), directionalMaterial: dirMat }, {}, flags);
  const floor = stat('DemoFloorWood', 'demo\\floor.nif', [128, 128, 0]);
  const wall = stat('DemoWallPlaster', 'demo\\wall.nif', [128, 8, 256]);
  const crate = stat('DemoCrate', 'demo\\crate.nif', [24, 24, 48]);
  const barrel = stat('DemoBarrel', 'demo\\barrel.nif', [20, 20, 56]);
  const pillar = stat('DemoPillar', 'demo\\pillar.nif', [20, 20, 256]);
  const table = stat('DemoTable', 'demo\\table.nif', [60, 36, 78]);
  stat('DemoStairs', 'demo\\stairs.nif', [128, 256, 128]);
  const rock = stat('DemoRock', 'demo\\rock.nif', [90, 70, 70]);
  const ground = stat('DemoGroundPatch', 'demo\\ground.nif', [4096, 4096, 120]);
  stat('XMarkerDemo', 'demo\\xmarker.nif', [8, 8, 16], 1 << 23);
  const light = rec(p, 'LIGH', id(), {
    editorId: 'DemoTorchLight',
    bounds: bounds(5, 5, 55),
    model: model('demo\\torch.nif'),
    data: { time: -1, radius: 512, color: { r: 255, g: 180, b: 110, unused: new Uint8Array(1) }, flags: 0, falloffExponent: 1, fov: 90, nearClip: 0, flickerPeriod: 0, flickerIntensityAmplitude: 0, flickerMovementAmplitude: 0, value: 0, weight: 0 },
    fadeValue: 1,
  });
  const door = rec(p, 'DOOR', id(), { editorId: 'DemoDoor', bounds: bounds(56, 10, 168), name: 'Door', model: model('demo\\door.nif'), flags: 0 });
  const chest = rec(p, 'CONT', id(), {
    editorId: 'DemoChest',
    bounds: bounds(41, 25, 52),
    name: 'Chest',
    model: model('demo\\chest.nif'),
    data: { flags: 0, weight: 0 },
    scripts: { version: 5, objectFormat: 2, scripts: [{ name: 'DemoChestScript', flags: 0, properties: [{ name: 'DemoWelcomeMsg', type: VmadPropertyType.Object, flags: 1, value: { form: msg, alias: -1 } }] }] },
  });

  // Clutter, plants, light sources and kit pieces for the environment tools (added last so earlier FormIDs stay put).
  const misc = (edid: string, name: string, file: string, b: [number, number, number], value: number, weight: number) =>
    rec(p, 'MISC', id(), { editorId: edid, bounds: bounds(...b), name, model: model(file), data: { value, weight } });
  misc('DemoTankard', 'Tankard', 'demo\\tankard.nif', [4, 4, 10], 2, 1);
  misc('DemoPlate', 'Plate', 'demo\\plate.nif', [8, 8, 2], 2, 1);
  misc('DemoBowl', 'Bowl', 'demo\\bowl.nif', [6, 6, 4], 1, 1);
  misc('DemoBottle', 'Bottle of Mead', 'demo\\bottle.nif', [3, 3, 14], 5, 0.5);
  misc('DemoSack', 'Sack', 'demo\\sack.nif', [14, 10, 22], 1, 2);
  const candle = stat('DemoCandleStick', 'demo\\candle.nif', [3, 3, 16]);
  stat('DemoBrazier', 'demo\\brazier.nif', [24, 24, 40]);
  stat('DemoBush', 'demo\\bush.nif', [40, 40, 50]);
  stat('DemoFern', 'demo\\fern.nif', [20, 20, 18]);
  stat('DemoWallCorner', 'demo\\wallcorner.nif', [12, 12, 256]);
  stat('DemoWallDoorway', 'demo\\walldoorway.nif', [128, 8, 256]);
  stat('DemoRoad', 'demo\\road.nif', [128, 64, 2]);
  stat('DemoFence', 'demo\\fence.nif', [64, 4, 60]);
  rec(p, 'LIGH', id(), {
    editorId: 'DemoCandleLight',
    bounds: bounds(0, 0, 0),
    data: { time: -1, radius: 256, color: { r: 255, g: 200, b: 140, unused: new Uint8Array(1) }, flags: 0, falloffExponent: 1, fov: 90, nearClip: 0, flickerPeriod: 0, flickerIntensityAmplitude: 0, flickerMovementAmplitude: 0, value: 0, weight: 0 },
    fadeValue: 1,
  });

  // Two idle animations (for gestures in dialogue).
  rec(p, 'IDLE', id(), { editorId: 'IdleWave', behaviorGraph: 'Actors\\Character\\Behaviors\\0_Master.hkx', animationEvent: 'IdleWave', related: [], data: { loopMin: 0, loopMax: 0, flags: 0, animationGroupSection: 0, replayDelay: 0 } });
  rec(p, 'IDLE', id(), { editorId: 'IdleLaugh', behaviorGraph: 'Actors\\Character\\Behaviors\\0_Master.hkx', animationEvent: 'IdleLaugh', related: [], data: { loopMin: 0, loopMax: 0, flags: 0, animationGroupSection: 0, replayDelay: 0 } });
  // Clothing and an outfit (for outfits in quest plans).
  const armo = (edid: string, name: string, slots: number, value: number) =>
    rec(p, 'ARMO', id(), { editorId: edid, bounds: bounds(12, 12, 40), name, maleModel: { file: 'demo\\clothes.nif' }, bodyTemplate: { slots, armorType: 2 }, description: '', armatures: [], data: { value, weight: 1 } });
  const shirt = armo('DemoClothesBlue', 'Blue Fine Clothes', 0x4, 40);
  const boots = armo('DemoBootsLeather', 'Leather Boots', 0x80, 10);
  armo('DemoHoodBrown', 'Brown Hood', 0x1 | 0x2, 5);
  rec(p, 'OTFT', id(), { editorId: 'DemoFarmerOutfit', items: [shirt, boots] });
  rec(p, 'FACT', id(), { editorId: 'DemoMerchantFaction', name: 'Merchants', relations: [], flags: 0 });
  // Stand-ins for the factions the game's own follower, marriage, shop and training dialogue looks for (same Editor IDs as Skyrim.esm).
  for (const edid of ['PotentialFollowerFaction', 'CurrentFollowerFaction', 'PotentialMarriageFaction', 'JobMerchantFaction', 'JobTrainerFaction', 'JobInnkeeperFaction']) rec(p, 'FACT', id(), { editorId: edid, relations: [], flags: 0 });
  rec(p, 'FLST', id(), { editorId: 'VendorItemsGeneralStore', forms: [] });

  // AI package templates (synthetic stand-ins for the game's Sandbox, Sleep, Eat, Travel, Follow and ForceGreet templates).
  const none = new Uint8Array(0);
  const boolIn = (on: number) => ({ type: 'Bool', value: new Uint8Array([on]), topics: [] });
  const floatIn = (f: number) => ({ type: 'Float', value: new Uint8Array(new Float32Array([f]).buffer), topics: [] });
  const locIn = () => ({ type: 'Location', topics: [], location: { type: 3, value: 0, radius: 512 } });
  const refIn = () => ({ type: 'SingleRef', topics: [], target: { type: 6, value: 0, count: 0 } });
  const topicIn = () => ({ type: 'Topic', topics: [{ type: 1, value: 'CUST' }] });
  const template = (edid: string, procedure: string, values: Record<string, unknown>[], names: string[]) =>
    rec(p, 'PACK', id(), {
      editorId: edid,
      data: { flags: 0, type: 19, interruptOverride: 0, speed: 0, unknown: new Uint8Array(1), interruptFlags: 0x1ff, unknown2: new Uint8Array(2) },
      schedule: { month: -1, dayOfWeek: -1, date: 0, hour: -1, minute: -1, unused: new Uint8Array(3), duration: 0 },
      counter: { inputCount: values.length, template: null, version: 1 },
      packageData: { values, inputs: names.map((name, index) => ({ index, name, flags: 1 })) },
      marker: none,
      tree: [{ type: 'Procedure', root: { count: 0, flags: 0 }, procedure, flags: 0, inputIndexes: values.map((_, index) => ({ index })) }],
      onBegin: { marker: none, idle: null, topics: [] },
      onEnd: { marker: none, idle: null, topics: [] },
      onChange: { marker: none, idle: null, topics: [] },
    });
  template('Sandbox', 'Sandbox', [locIn(), boolIn(1), boolIn(1), boolIn(1), boolIn(1), boolIn(1), floatIn(50)], ['Location', 'AllowEating', 'AllowSleeping', 'AllowConversation', 'AllowIdleMarkers', 'AllowSitting', 'Energy']);
  template('Sleep', 'Sleep', [locIn(), boolIn(1)], ['Location', 'LockDoors']);
  template('Eat', 'Eat', [locIn(), boolIn(1)], ['Location', 'AllowAlreadyHeld']);
  template('Travel', 'Travel', [locIn()], ['PlaceToTravelTo']);
  template('Follow', 'Follow', [refIn(), floatIn(150), floatIn(300)], ['TargetToFollow', 'MinRadius', 'MaxRadius']);
  template('ForceGreet', 'ForceGreet', [refIn(), topicIn()], ['ForceGreetTarget', 'Topic']);
  // ---- interior cell: the Demo Tavern
  const tavern = 0xa00;
  rec(p, 'CELL', tavern, {
    editorId: 'DemoTavern',
    name: 'The Demo Tavern',
    flags: 1,
    lighting: {
      ambient: { r: 70, g: 60, b: 52 },
      directional: { r: 150, g: 130, b: 110 },
      fogNearColor: { r: 20, g: 18, b: 16 },
      fogNear: 0,
      fogFar: 6000,
      directionalRotationXY: 45,
      directionalRotationZ: 45,
      directionalFade: 1,
      fogClipDistance: 0,
      fogPower: 1,
      ambientColors: new Uint8Array(32),
      fogFarColor: { r: 30, g: 26, b: 22 },
      fogMax: 1,
      lightFadeBegin: 0,
      lightFadeEnd: 0,
      inherits: 0,
    },
  });
  let refId = 0xa01;
  const place = (base: number, x: number, y: number, z: number, rz = 0, opts: { persistent?: boolean; scale?: number; edid?: string; sig?: string } = {}) => {
    const r = refId++;
    const data: Record<string, unknown> = { base, placement: posRot(x, y, z, rz) };
    if (opts.scale) data.scale = opts.scale;
    if (opts.edid) data.editorId = opts.edid;
    rec(p, opts.sig ?? 'REFR', r, data, { cell: tavern, persistent: opts.persistent }, opts.persistent ? RecordFlags.Persistent : 0);
    return r;
  };
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) place(floor, -384 + i * 256, -384 + j * 256, 0);
  for (let i = 0; i < 4; i++) {
    place(wall, -384 + i * 256, -512, 0);
    place(wall, -384 + i * 256, 512, 0, Math.PI);
    place(wall, -512, -384 + i * 256, 0, Math.PI / 2);
    if (i !== 1) place(wall, 512, -384 + i * 256, 0, -Math.PI / 2);
  }
  place(pillar, 0, 0, 0);
  place(table, -200, 150, 0);
  place(table, 200, 180, 0, 0.4);
  place(crate, -420, -420, 0);
  place(crate, -420, -360, 0, 0.3);
  place(crate, -420, -390, 48, 0.8);
  place(barrel, 420, -420, 0);
  place(barrel, 380, -440, 0);
  place(chest, -420, 300, 0, Math.PI / 2, { edid: 'DemoTavernChestRef' });
  place(light, -480, 0, 180, 0);
  place(light, 480, 300, 180, 0);
  place(door, 512, -128, 0, -Math.PI / 2, { edid: 'DemoTavernDoorRef', persistent: true });
  place(keeper, 150, 250, 0, Math.PI, { persistent: true, sig: 'ACHR', edid: 'DemoInnkeeperRef' });
  place(smith, -250, -200, 0, 0.5, { persistent: true, sig: 'ACHR', edid: 'DemoBlacksmithRef' });

  // Landscape textures to paint the ground with (texture set → landscape texture, as in the game).
  for (const [edid, file] of [
    ['DemoLandGrass', 'grass'],
    ['DemoLandRock', 'rock'],
    ['DemoLandDirt', 'wood'],
  ] as const) {
    const txst = rec(p, 'TXST', id(), { editorId: `${edid}TX`, bounds: bounds(0, 0, 0), textures: { diffuse: `demo\\${file}.dds` } });
    rec(p, 'LTEX', id(), { editorId: edid, textureSet: txst, havok: { friction: 30, restitution: 30 }, specular: 30, grasses: [] });
  }

  // ---- exterior worldspace with two cells
  const world = 0xb00;
  rec(p, 'WRLD', world, { editorId: 'DemoWorld', name: 'Demo Valley', parent: {}, distantLodMultiplier: 1, flags: 0x1 | 0x10 });
  let cellId = 0xb01;
  for (const gx of [0, 1]) {
    const c = cellId++;
    const xclc = { x: gx, y: 0, forceHideLand: 0 };
    rec(p, 'CELL', c, { editorId: `DemoValley${gx}_0`, flags: 0, grid: xclc }, { worldspace: world, grid: { x: gx, y: 0 } });
    if (gx === 0) {
      // Cell (0,0) uses a ground mesh; cell (1,0) uses real LAND terrain.
      const r = refId++;
      rec(p, 'REFR', r, { base: ground, placement: posRot(gx * 4096, 0, 0) }, { cell: c });
    } else {
      rec(p, 'LAND', cellId + 0x40, landData(gx, 0), { cell: c });
    }
    for (let k = 0; k < 4; k++) {
      const rr = refId++;
      rec(p, 'REFR', rr, { base: rock, placement: posRot(gx * 4096 + 600 + k * 800, 900 + ((k * 1300) % 2000), 30, k), scale: 0.8 + k * 0.2 }, { cell: c });
    }
  }

  // An unlit candle on a table (for the lighting pass).
  place(candle, -200, 150, 78);

  // ---- a quest with dialogue
  const quest = 0xc00;
  const isId = conditionFunctionByName('GetIsID')!.index;
  const getStage = conditionFunctionByName('GetStage')!.index;
  rec(p, 'QUST', quest, {
    editorId: 'DemoTavernQuest',
    name: 'A Quiet Drink',
    general: { flags: 0x1, priority: 40, formVersion: 0, unknown: new Uint8Array(4), type: 8 },
    marker: true,
    stages: [
      { index: { index: 0, flags: 2, unknown: 0 }, logEntries: [] },
      { index: { index: 10, flags: 0, unknown: 0 }, logEntries: [{ flags: 0, text: 'Brynja at the Demo Tavern has a job for me.' }] },
      { index: { index: 20, flags: 0, unknown: 0 }, logEntries: [{ flags: 0, text: 'I found the missing crate.' }] },
      { index: { index: 100, flags: 0, unknown: 0 }, logEntries: [{ flags: 1, text: 'Brynja paid me for my help.' }] },
    ],
    objectives: [
      { index: 10, oredWithPrevious: 0, text: 'Find the missing crate', targets: [] },
      { index: 20, oredWithPrevious: 0, text: 'Return to Brynja', targets: [{ target: { alias: 0, ignoresLocks: 0, unused: new Uint8Array(3) } }] },
    ],
    nextAliasId: 1,
    aliases: [{ option: 0, value: { id: 0, name: 'Innkeeper', flags: 0x40, fill: { option: 1, value: { actor: keeper } }, end: true } }],
    scripts: { version: 5, objectFormat: 2, scripts: [{ name: 'DemoQuestScript', flags: 0, properties: [] }] },
  });
  const topic = 0xc01;
  rec(p, 'DIAL', topic, { editorId: 'DemoTavernJobTopic', name: 'Got any work for me?', priority: 50, quest, data: { doAllBeforeRepeating: 0, category: 0, subtype: 0 }, subtypeName: 'CUST', infoCount: 1 });
  rec(p, 'DLBR', 0xc02, { editorId: 'DemoTavernJobBranch', quest, category: 0, flags: 1, startingTopic: topic });
  rec(
    p,
    'INFO',
    0xc03,
    {
      data: { flags: 0, resetHours: 0 },
      favorLevel: 0,
      responses: [
        { data: { emotion: 5, emotionValue: 40, unused: new Uint8Array(4), responseNumber: 1, unused2: new Uint8Array(3), sound: 0, useEmotionAnimation: 0, unused3: new Uint8Array(3) }, text: 'A crate of mead went missing from the cellar.' },
        { data: { emotion: 0, emotionValue: 50, unused: new Uint8Array(4), responseNumber: 2, unused2: new Uint8Array(3), sound: 0, useEmotionAnimation: 0, unused3: new Uint8Array(3) }, text: 'Find it and I will make it worth your while.' },
      ],
      conditions: [{ data: { ...newCondition(isId), param1: keeper } }, { data: { ...newCondition(getStage), param1: quest, op: '<', value: 10 } }],
    },
    { topic },
  );
  void table;
  return p;
}

/** A plugin with typical "dirty" edits for demonstrating the cleaner. */
function buildDirtyPatch(master: Plugin): Plugin {
  const p = Plugin.create('DirtyPatch.esp', { masters: ['DemoWorld.esm'], author: 'Someone in a hurry' });
  const crate = [...master.recordsOfType('STAT')].find((r) => r.editorId === 'DemoCrate')!;
  placeRecord(p, crate.clone()); // ITM
  const cell = [...master.recordsOfType('CELL')].find((r) => r.editorId === 'DemoTavern')!;
  placeRecord(p, cell.clone()); // ITM parent cell
  const refs = master.childGroupOf(cell)!.groups.flatMap((g) => g.records);
  const baseOf = (r: PluginRecord) => new DataView(r.get('NAME')!.data.buffer, r.get('NAME')!.data.byteOffset, 4).getUint32(0, true);
  const crates = refs.filter((r) => r.sig === 'REFR' && baseOf(r) === crate.formId);
  const barrels = refs.filter((r) => r.sig === 'REFR' && r.get('NAME') && [...master.recordsOfType('STAT')].find((s) => s.formId === baseOf(r))?.editorId === 'DemoBarrel');
  placeRecord(p, crates[0]!.clone(), { cell: cell.formId }); // ITM reference
  placeRecord(p, new PluginRecord({ sig: 'REFR', formId: barrels[0]!.formId, flags: RecordFlags.Deleted }, new Uint8Array(0)), { cell: cell.formId }); // UDR: deleted barrel
  const moved = crates[1]!.clone(); // a real edit: move a crate
  const d = moved.get('DATA')!.data.slice();
  new DataView(d.buffer).setFloat32(0, -300, true);
  moved.set('DATA', d);
  placeRecord(p, moved, { cell: cell.formId });
  p.updateHeaderBookkeeping();
  return p;
}

/** A small BodySlide set (mesh, sliders, morphs and presets) so the Body tab has something to show. */
function demoBodySlide(): Record<string, Uint8Array> {
  const enc = (t: string) => new TextEncoder().encode(t);
  const body = ellipsoid(18, 11, 45, 90, 16, 24);
  const count = body.positions.length / 3;
  /** A sparse morph: `move` gives the offset for the vertices it touches. */
  const morph = (move: (x: number, y: number, z: number) => [number, number, number] | null): ShapeDiff => {
    const indices: number[] = [];
    const deltas: number[] = [];
    for (let v = 0; v < count; v++) {
      const d = move(body.positions[v * 3]!, body.positions[v * 3 + 1]!, body.positions[v * 3 + 2]!);
      if (d && (d[0] || d[1] || d[2])) {
        indices.push(v);
        deltas.push(...d);
      }
    }
    return { indices: Uint32Array.from(indices), deltas: Float32Array.from(deltas) };
  };
  const bump = (z: number, c: number, r: number) => Math.max(0, 1 - Math.abs(z - c) / r);
  const osd = writeOsd({
    Breasts: morph((x, y, z) => {
      const k = bump(z, 118, 14);
      return y > 0 && k ? [Math.sign(x) * 1.5 * k, 5 * k, 0] : null;
    }),
    Waist: morph((x, y, z) => {
      const k = bump(z, 96, 16);
      return k ? [-x * 0.3 * k, -y * 0.3 * k, 0] : null;
    }),
    Hips: morph((x, y, z) => {
      const k = bump(z, 74, 18);
      return k ? [x * 0.35 * k, y * 0.2 * k, 0] : null;
    }),
    Height: morph((_x, _y, z) => [0, 0, (z - 45) * 0.08]),
  });
  const osp = `<?xml version="1.0" encoding="UTF-8"?>
<SliderSetInfo version="1">
\t<SliderSet name="Demo Body">
\t\t<DataFolder>DemoBody</DataFolder>
\t\t<SourceFile>meshes\\demo\\bodyslide\\demobody_1.nif</SourceFile>
\t\t<OutputPath>meshes\\demo\\bodyslide</OutputPath>
\t\t<OutputFile>demobody</OutputFile>
\t\t<Shape target="DemoBody">DemoBody</Shape>
\t\t<Slider name="Breasts" invert="false" small="0" big="40"><Data name="Breasts" target="DemoBody" local="true"/></Slider>
\t\t<Slider name="Waist" invert="false" small="0" big="0"><Data name="Waist" target="DemoBody" local="true"/></Slider>
\t\t<Slider name="Hips" invert="false" small="0" big="0"><Data name="Hips" target="DemoBody" local="true"/></Slider>
\t\t<Slider name="Height" invert="false" small="0" big="0"><Data name="Height" target="DemoBody" local="true"/></Slider>
\t</SliderSet>
</SliderSetInfo>
`;
  const presets = `<?xml version="1.0" encoding="UTF-8"?>
<SliderPresets>
\t<Preset name="Demo Slim" set="Demo Body">
\t\t<SetSlider name="Waist" size="small" value="60"/><SetSlider name="Waist" size="big" value="60"/>
\t\t<SetSlider name="Hips" size="small" value="10"/><SetSlider name="Hips" size="big" value="20"/>
\t</Preset>
\t<Preset name="Demo Curvy" set="Demo Body">
\t\t<SetSlider name="Breasts" size="small" value="30"/><SetSlider name="Breasts" size="big" value="100"/>
\t\t<SetSlider name="Hips" size="small" value="50"/><SetSlider name="Hips" size="big" value="100"/>
\t\t<SetSlider name="Waist" size="small" value="30"/><SetSlider name="Waist" size="big" value="40"/>
\t</Preset>
</SliderPresets>
`;
  return {
    'meshes\\demo\\bodyslide\\demobody_1.nif': nif(['DemoBody', body, [T('skin')]]),
    'CalienteTools\\BodySlide\\SliderSets\\DemoBody.osp': enc(osp),
    'CalienteTools\\BodySlide\\SliderPresets\\Demo.xml': enc(presets),
    'CalienteTools\\BodySlide\\ShapeData\\DemoBody\\DemoBody.osd': osd,
  };
}

/** Write the demo game folder into a memory file system. */
export function createDemoData(fs: MemoryFileSystem, root = '/Demo/Skyrim Special Edition'): DemoPaths {
  const dataDir = `${root}/Data`;
  fs.writeFileSync(`${root}/SkyrimSE.exe`, new Uint8Array(0));
  const master = buildDemoMaster();
  master.updateHeaderBookkeeping();
  fs.writeFileSync(`${dataDir}/DemoWorld.esm`, master.serialize());
  fs.writeFileSync(`${dataDir}/DirtyPatch.esp`, buildDirtyPatch(master).serialize());
  for (const [path, bytes] of Object.entries({ ...meshesAndTextures(), ...demoBodySlide() })) fs.writeFileSync(`${dataDir}/${path.replace(/\\/g, '/')}`, bytes);
  for (const [name, src] of Object.entries(SCRIPTS)) fs.writeFileSync(`${dataDir}/Source/Scripts/${name}.psc`, src.replace(/\n/g, '\r\n'));
  fs.writeFileSync(`${dataDir}/Source/Scripts/TESV_Papyrus_Flags.flg`, 'Flag hidden 0\r\nFlag conditional 1\r\n');
  return { gameDir: root, dataDir, plugins: ['DemoWorld.esm', 'DirtyPatch.esp'] };
}
export * from './example-plan';
