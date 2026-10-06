import type { BinaryWriter } from './binary';
import { hex } from './binary';
import { GroupType } from './constants';
import type { PluginRecord } from './record';

export const GROUP_HEADER_SIZE = 24;

export type PluginNode = PluginRecord | PluginGroup;

/**
 * A GRUP. The meaning of `label` depends on `type`:
 * top groups store a record signature, child groups the parent FormID,
 * cell blocks a block number or packed grid coordinates.
 */
export class PluginGroup {
  readonly kind = 'group' as const;
  type: GroupType;
  /** Raw 32-bit label. */
  label: number;
  /** Timestamp / version control (u16 + u16) — ignored by the game. */
  stamp: number;
  /** Trailing unknown u32. */
  unknown: number;
  children: PluginNode[];
  offset = -1;

  constructor(type: GroupType, label: number, children: PluginNode[] = [], stamp = 0, unknown = 0) {
    this.type = type;
    this.label = label >>> 0;
    this.children = children;
    this.stamp = stamp >>> 0;
    this.unknown = unknown >>> 0;
  }

  static top(sig: string): PluginGroup {
    return new PluginGroup(GroupType.Top, sigToLabel(sig));
  }

  /** Signature stored in the label of a top-level group. */
  get labelSig(): string {
    return labelToSig(this.label);
  }

  /** Grid coordinates stored in the label of an exterior block/sub-block. */
  get labelGrid(): { x: number; y: number } {
    const y = (this.label << 16) >> 16; // low 16 bits, signed
    const x = this.label >> 16; // high 16 bits, signed
    return { x, y };
  }

  get isEmpty(): boolean {
    return this.children.length === 0;
  }

  /** Records directly inside this group. */
  get records(): PluginRecord[] {
    return this.children.filter((c): c is PluginRecord => c.kind === 'record');
  }

  get groups(): PluginGroup[] {
    return this.children.filter((c): c is PluginGroup => c.kind === 'group');
  }

  writeTo(w: BinaryWriter): void {
    const start = w.pos;
    w.sig('GRUP').u32(0).u32(this.label).i32(this.type).u32(this.stamp).u32(this.unknown);
    for (const c of this.children) c.writeTo(w);
    w.patchU32(start + 4, w.pos - start);
  }

  describe(): string {
    switch (this.type) {
      case GroupType.Top:
        return `GRUP Top "${this.labelSig}"`;
      case GroupType.WorldChildren:
        return `GRUP World Children of [${hex(this.label)}]`;
      case GroupType.InteriorCellBlock:
        return `GRUP Block ${this.label | 0}`;
      case GroupType.InteriorCellSubBlock:
        return `GRUP Sub-Block ${this.label | 0}`;
      case GroupType.ExteriorCellBlock: {
        const g = this.labelGrid;
        return `GRUP Block ${g.x}, ${g.y}`;
      }
      case GroupType.ExteriorCellSubBlock: {
        const g = this.labelGrid;
        return `GRUP Sub-Block ${g.x}, ${g.y}`;
      }
      case GroupType.CellChildren:
        return `GRUP Cell Children of [${hex(this.label)}]`;
      case GroupType.TopicChildren:
        return `GRUP Topic Children of [${hex(this.label)}]`;
      case GroupType.CellPersistentChildren:
        return `GRUP Persistent Children of [${hex(this.label)}]`;
      case GroupType.CellTemporaryChildren:
        return `GRUP Temporary Children of [${hex(this.label)}]`;
      case GroupType.CellVisibleDistantChildren:
        return `GRUP Visible When Distant Children of [${hex(this.label)}]`;
      default:
        return `GRUP type ${this.type} label ${hex(this.label)}`;
    }
  }
}

export function sigToLabel(sig: string): number {
  if (sig.length !== 4) throw new Error(`Invalid signature "${sig}"`);
  return (sig.charCodeAt(0) | (sig.charCodeAt(1) << 8) | (sig.charCodeAt(2) << 16) | (sig.charCodeAt(3) << 24)) >>> 0;
}

export function labelToSig(label: number): string {
  return String.fromCharCode(label & 0xff, (label >>> 8) & 0xff, (label >>> 16) & 0xff, (label >>> 24) & 0xff);
}

/** Pack exterior grid coordinates the way block/sub-block labels store them (Y in low word, X in high word). */
export function gridToLabel(x: number, y: number): number {
  return (((x & 0xffff) << 16) | (y & 0xffff)) >>> 0;
}

/** Interior cell block number: last decimal digit of the object ID. */
export function interiorBlock(formId: number): { block: number; subBlock: number } {
  const objectId = formId & 0xffffff;
  return { block: objectId % 10, subBlock: Math.floor(objectId / 10) % 10 };
}

/** Exterior cell block/sub-block coordinates (blocks are 32×32 cells, sub-blocks 8×8). */
export function exteriorBlock(cellX: number, cellY: number): {
  block: { x: number; y: number };
  subBlock: { x: number; y: number };
} {
  return {
    block: { x: Math.floor(cellX / 32), y: Math.floor(cellY / 32) },
    subBlock: { x: Math.floor(cellX / 8), y: Math.floor(cellY / 8) },
  };
}
