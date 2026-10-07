/**
 * Simple editors for the Items and Magic workspaces. Each shows the fields that
 * matter for that kind of record, in plain words, with help on anything that
 * isn't obvious. Everything else stays reachable with "Show every field".
 */
import type { ReactNode } from 'react';
import { ACTOR_VALUES, ARCHETYPES, ENTRY_FUNCTIONS, ENTRY_POINTS, type FormKey } from '@tes5/esp';
import type { RecordView } from '@tes5/workspace';
import { Checkbox, DragNumber, Field, FormPicker, Help, Icon, Section, Select, Slider, TextInput, useQuery, useSummaries } from '../../components/ui';
import { useStore } from '../../state/store';
import { ConditionList } from '../record/ConditionEditor';

type Data = Record<string, any>;
export interface EditorProps {
  view: RecordView;
  data: Data;
  commit: (d: Data) => void;
}

// ------------------------------------------------------------------ shared pieces

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bit = (flags: unknown, b: number) => (num(flags) & (1 << b)) !== 0;
const setBit = (flags: unknown, b: number, on: boolean) => (on ? num(flags) | (1 << b) : num(flags) & ~(1 << b)) >>> 0;

function Pad({ children }: { children: ReactNode }) {
  return <div className="pad catalog-section">{children}</div>;
}

function Title({ children, help }: { children: ReactNode; help?: string }) {
  return (
    <>
      {children}
      {help && (
        <>
          {' '}
          <Help text={help} />
        </>
      )}
    </>
  );
}

function NameField({ data, commit, label = 'Name', help }: { data: Data; commit: (d: Data) => void; label?: string; help?: string }) {
  return (
    <Field label={label} title={help ?? 'What players see in menus and in the world.'}>
      <TextInput value={String(data.name ?? '')} onCommit={(name) => commit({ ...data, name })} />
    </Field>
  );
}

function Num({ value, onCommit, step = 1, precision = 0, min, max, suffix }: { value: unknown; onCommit: (v: number) => void; step?: number; precision?: number; min?: number; max?: number; suffix?: string }) {
  return <DragNumber value={num(value)} onCommit={onCommit} step={step} precision={precision} min={min} max={max} suffix={suffix} />;
}

/** Editable list of forms (keywords, armor addons, outfit pieces…). */
function FormList({ value, sigs, onChange, addLabel, empty }: { value: (FormKey | null)[] | undefined; sigs: string[]; onChange: (v: (FormKey | null)[]) => void; addLabel: string; empty: string }) {
  const list = value ?? [];
  return (
    <div className="col" style={{ gap: 4 }}>
      {list.map((k, i) => (
        <div key={i} className="row" style={{ gap: 4 }}>
          <div className="grow">
            <FormPicker value={k} sigs={sigs} onChange={(v) => onChange(list.map((x, j) => (j === i ? v : x)))} />
          </div>
          <button className="btn icon ghost" title="Remove" onClick={() => onChange(list.filter((_, j) => j !== i))}>
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
      {!list.length && <div className="faint small">{empty}</div>}
      <div>
        <button className="btn small ghost" onClick={() => onChange([...list, null])}>
          <Icon name="plus" size={12} /> {addLabel}
        </button>
      </div>
    </div>
  );
}

function Keywords({ data, commit, help }: { data: Data; commit: (d: Data) => void; help: string }) {
  return (
    <Pad>
      <Section title={<Title help={help}>Keywords</Title>}>
        <FormList value={data.keywords} sigs={['KYWD']} onChange={(keywords) => commit({ ...data, keywords })} addLabel="Add keyword" empty="No keywords." />
      </Section>
    </Pad>
  );
}

const SKILLS = [-1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].map((v) => ({ value: v, label: v < 0 ? 'None' : ACTOR_VALUE_LABEL(v) }));
function ACTOR_VALUE_LABEL(v: number): string {
  const n = ACTOR_VALUES[v] ?? String(v);
  const nice: Record<string, string> = { OneHanded: 'One-handed', TwoHanded: 'Two-handed', Marksman: 'Archery', HeavyArmor: 'Heavy armor', LightArmor: 'Light armor', Speechcraft: 'Speech', Pickpocket: 'Pickpocket' };
  return nice[n] ?? n.replace(/([a-z])([A-Z])/g, '$1 $2');
}
const ALL_ACTOR_VALUES = Object.keys(ACTOR_VALUES)
  .map(Number)
  .sort((a, b) => a - b)
  .map((v) => ({ value: v, label: v < 0 ? 'None' : ACTOR_VALUE_LABEL(v) }));

// ------------------------------------------------------------------ effects (spells, potions, enchantments…)

const NO_EFFECT_HELP = 'Pick a magic effect (like Fire Damage or Restore Health), then set how strong it is and how long it lasts.';

function EffectsEditor({ value, onChange, help, noDuration }: { value: Data[] | undefined; onChange: (v: Data[]) => void; help: string; noDuration?: boolean }) {
  const list = value ?? [];
  const sums = useSummaries(list.map((e) => e.effect));
  return (
    <Pad>
      <Section
        title={<Title help={help}>Effects</Title>}
        actions={
          <button className="btn small" onClick={() => onChange([...list, { effect: null, data: { magnitude: 10, area: 0, duration: noDuration ? 0 : 30 } }])} data-testid="add-effect">
            <Icon name="plus" size={12} /> Add effect
          </button>
        }
      >
        {!list.length && <div className="faint small">No effects yet. {NO_EFFECT_HELP}</div>}
        {list.map((e, i) => {
          const s = e.effect ? sums[e.effect] : undefined;
          const set = (patch: Data) => onChange(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          const d = e.data ?? {};
          const conds: Data[] = e.conditions ?? [];
          const sentence = [`${s?.name ?? s?.editorId ?? 'Choose an effect'}`, `strength ${num(d.magnitude)}`, num(d.duration) ? `for ${num(d.duration)} s` : null, num(d.area) ? `in a ${num(d.area)} ft area` : null].filter(Boolean).join(', ');
          return (
            <div key={i} className="card catalog-effect" data-testid="effect-row">
              <div className="row" style={{ gap: 6 }}>
                <div className="grow">
                  <FormPicker value={e.effect} sigs={['MGEF']} onChange={(effect) => set({ effect })} placeholder="Choose a magic effect…" />
                </div>
                <button className="btn icon ghost" title="Remove this effect" onClick={() => onChange(list.filter((_, j) => j !== i))}>
                  <Icon name="close" size={12} />
                </button>
              </div>
              <div className="catalog-grid3">
                <Field label="Strength" title="The magnitude: points of damage or healing, percent, or level, depending on the effect.">
                  <Num value={d.magnitude} step={1} precision={2} min={0} onCommit={(magnitude) => set({ data: { ...d, magnitude } })} />
                </Field>
                <Field label="Lasts (s)" title="Duration in seconds. 0 means instant, or for as long as it's worn or held.">
                  <Num value={d.duration} min={0} onCommit={(duration) => set({ data: { ...d, duration } })} />
                </Field>
                <Field label="Area (ft)" title="Radius in feet that it affects. 0 means only the target.">
                  <Num value={d.area} min={0} onCommit={(area) => set({ data: { ...d, area } })} />
                </Field>
              </div>
              <div className="small dim">{sentence}</div>
              <details>
                <summary className="small dim" style={{ cursor: 'pointer' }}>
                  Only when… ({conds.length}) <Help text="Conditions on this one effect, e.g. only on undead (HasKeyword ActorTypeUndead) or only below half health." />
                </summary>
                <ConditionList items={conds as any} onChange={(items) => set({ conditions: items.length ? items : undefined })} />
              </details>
            </div>
          );
        })}
      </Section>
    </Pad>
  );
}

// ------------------------------------------------------------------ spells

const SPELL_KINDS = [
  { value: 0, label: 'Spell (costs magicka)' },
  { value: 2, label: 'Greater power (once a day)' },
  { value: 3, label: 'Lesser power (any time)' },
  { value: 4, label: 'Ability (always on)' },
  { value: 1, label: 'Disease' },
  { value: 5, label: 'Poison' },
  { value: 10, label: 'Addiction' },
  { value: 11, label: 'Shout spell' },
];
const CASTING = [
  { value: 1, label: 'Fire and forget' },
  { value: 2, label: 'Concentration (held)' },
  { value: 0, label: 'Constant (always on)' },
];
const TARGETS = [
  { value: 0, label: 'Self' },
  { value: 1, label: 'Touch' },
  { value: 2, label: 'Aimed (projectile)' },
  { value: 3, label: 'Target actor' },
  { value: 4, label: 'Target location' },
];

function SpellEditor({ data, commit }: EditorProps) {
  const d = data.data ?? {};
  const setD = (patch: Data) => commit({ ...data, data: { ...d, ...patch } });
  const auto = !bit(d.flags, 0);
  const isSpell = num(d.type) === 0;
  return (
    <>
      <Pad>
        <div className="catalog-grid2">
          <NameField data={data} commit={commit} />
          <Field label="Kind" title="Spells cost magicka; powers are used from the Z key; abilities are always on (racial traits, blessings); diseases and poisons are caught or applied.">
            <Select value={num(d.type)} options={SPELL_KINDS} onChange={(type) => setD({ type })} />
          </Field>
          <Field label="Casting" title="Fire and forget casts once; concentration keeps going while the button is held; constant is always on (abilities, diseases).">
            <Select value={num(d.castingType)} options={CASTING} onChange={(castingType) => setD({ castingType })} />
          </Field>
          <Field label="Target" title="Self affects the caster; touch needs contact; aimed fires a projectile; target actor/location affect what the caster looks at.">
            <Select value={num(d.delivery)} options={TARGETS} onChange={(delivery) => setD({ delivery })} />
          </Field>
          <Field label="Hands" title="Which hand(s) it's cast with: EitherHand, BothHands (ritual spells), or Voice for shout spells.">
            <FormPicker value={data.equipType ?? null} sigs={['EQUP']} onChange={(equipType) => commit({ ...data, equipType })} />
          </Field>
          {isSpell && (
            <Field label="Charge time (s)" title="How long the cast takes before it can be released.">
              <Num value={d.chargeTime} step={0.05} precision={2} min={0} onCommit={(chargeTime) => setD({ chargeTime })} />
            </Field>
          )}
        </div>
        <div className="catalog-grid2">
          <Field label="Magicka cost" title="With automatic cost on, the game works the cost out from the effects (and the caster's skill and perks), like the Creation Kit's auto-calculate.">
            <div className="row" style={{ gap: 6 }}>
              <div style={{ width: 90 }}>
                <DragNumber value={num(d.baseCost)} disabled={auto} step={1} precision={0} min={0} onCommit={(baseCost) => setD({ baseCost })} />
              </div>
              <Checkbox checked={auto} onChange={(on) => setD({ flags: setBit(d.flags, 0, !on) })} label="Automatic" />
            </div>
          </Field>
          <Field label="Half-cost perk" title="The perk that halves this spell's cost, e.g. NoviceDestruction.">
            <FormPicker value={d.halfCostPerk ?? null} sigs={['PERK']} onChange={(halfCostPerk) => setD({ halfCostPerk })} />
          </Field>
        </div>
        <Field label="Description" title="Shown in the magic menu. <mag> and <dur> are replaced by the strength and duration of the first effect." stack>
          <TextInput value={String(data.description ?? '')} multiline onCommit={(description) => commit({ ...data, description })} />
        </Field>
        <div className="row wrap" style={{ gap: 12, marginTop: 6 }}>
          <Checkbox checked={bit(d.flags, 20)} onChange={(on) => setD({ flags: setBit(d.flags, 20, on) })} label="Ignores resistances" />
          <Checkbox checked={bit(d.flags, 21)} onChange={(on) => setD({ flags: setBit(d.flags, 21, on) })} label="Can't be absorbed or reflected" />
          <Checkbox checked={bit(d.flags, 19)} onChange={(on) => setD({ flags: setBit(d.flags, 19, on) })} label="Area ignores line of sight" />
          <Checkbox checked={bit(d.flags, 17)} onChange={(on) => setD({ flags: setBit(d.flags, 17, on) })} label="Player starts with it" help="Given to the player at the start of the game." />
        </div>
      </Pad>
      <EffectsEditor value={data.effects} onChange={(effects) => commit({ ...data, effects })} help="What the spell does. Each effect has a strength, a duration and an area, and can be limited by conditions." />
    </>
  );
}

function EnchantmentEditor({ data, commit }: EditorProps) {
  const d = data.data ?? {};
  const setD = (patch: Data) => commit({ ...data, data: { ...d, ...patch } });
  const use = num(d.enchantType) === 12 ? 'staff' : num(d.castingType) === 0 ? 'worn' : 'weapon';
  const auto = !bit(d.flags, 0);
  return (
    <>
      <Pad>
        <div className="catalog-grid2">
          <NameField data={data} commit={commit} />
          <Field label="Used on" title="Worn items (armor, jewelry) apply their effects all the time; weapons apply them on each hit and use charge; staffs cast it.">
            <Select
              value={use}
              options={[
                { value: 'weapon', label: 'Weapon (on hit)' },
                { value: 'worn', label: 'Worn item (always on)' },
                { value: 'staff', label: 'Staff' },
              ]}
              onChange={(u) => setD(u === 'worn' ? { castingType: 0, delivery: 0, enchantType: 6 } : u === 'staff' ? { castingType: 1, delivery: 2, enchantType: 12 } : { castingType: 1, delivery: 1, enchantType: 6 })}
            />
          </Field>
          <Field label="Charge cost" title="Charge used per hit (weapons). With automatic on, the game works it out from the effects.">
            <div className="row" style={{ gap: 6 }}>
              <div style={{ width: 90 }}>
                <DragNumber value={num(d.enchantmentCost)} disabled={auto} step={1} precision={0} min={0} onCommit={(enchantmentCost) => setD({ enchantmentCost })} />
              </div>
              <Checkbox checked={auto} onChange={(on) => setD({ flags: setBit(d.flags, 0, !on) })} label="Automatic" />
            </div>
          </Field>
          <Field label="Only on items with" title="A list of keywords; only items with one of them can get this enchantment at an arcane enchanter (e.g. armor that isn't a shield).">
            <FormPicker value={d.wornRestrictions ?? null} sigs={['FLST']} onChange={(wornRestrictions) => setD({ wornRestrictions })} />
          </Field>
          <Field label="Based on" title="For enchantments made from another one (like a stronger version): the original. Players learn the original by disenchanting.">
            <FormPicker value={d.baseEnchantment ?? null} sigs={['ENCH']} onChange={(baseEnchantment) => setD({ baseEnchantment })} />
          </Field>
        </div>
      </Pad>
      <EffectsEditor value={data.effects} onChange={(effects) => commit({ ...data, effects })} noDuration={use === 'worn'} help="What the enchantment does. For worn items the duration is ignored (it lasts while worn)." />
    </>
  );
}

function ScrollEditor({ data, commit }: EditorProps) {
  const d = data.data ?? {};
  const v = data.value ?? {};
  return (
    <>
      <Pad>
        <div className="catalog-grid2">
          <NameField data={data} commit={commit} />
          <Field label="Target" title="Who or what the scroll affects when read.">
            <Select value={num(d.delivery)} options={TARGETS} onChange={(delivery) => commit({ ...data, data: { ...d, delivery } })} />
          </Field>
          <Field label="Value (gold)">
            <Num value={v.value} min={0} onCommit={(value) => commit({ ...data, value: { ...v, value } })} />
          </Field>
          <Field label="Weight">
            <Num value={v.weight} step={0.1} precision={2} min={0} onCommit={(weight) => commit({ ...data, value: { ...v, weight } })} />
          </Field>
        </div>
      </Pad>
      <EffectsEditor value={data.effects} onChange={(effects) => commit({ ...data, effects })} help="What happens when the scroll is read (it's used up)." />
    </>
  );
}

// ------------------------------------------------------------------ potions & ingredients

function PotionEditor({ data, commit }: EditorProps) {
  const d = data.data ?? {};
  const setD = (patch: Data) => commit({ ...data, data: { ...d, ...patch } });
  const kind = bit(d.flags, 17) ? 'poison' : bit(d.flags, 1) ? 'food' : 'potion';
  const auto = !bit(d.flags, 0);
  return (
    <>
      <Pad>
        <div className="catalog-grid2">
          <NameField data={data} commit={commit} />
          <Field label="Kind" title="Potions are drunk from the inventory; food is eaten (and counts for survival and cooking); poisons are applied to a weapon.">
            <Select
              value={kind}
              options={[
                { value: 'potion', label: 'Potion' },
                { value: 'food', label: 'Food or drink' },
                { value: 'poison', label: 'Poison' },
              ]}
              onChange={(k) => {
                let f = setBit(setBit(setBit(d.flags, 1, k === 'food'), 17, k === 'poison'), 16, k === 'potion');
                setD({ flags: f });
              }}
            />
          </Field>
          <Field label="Value (gold)" title="With automatic on, the game works the price out from the effects.">
            <div className="row" style={{ gap: 6 }}>
              <div style={{ width: 90 }}>
                <DragNumber value={num(d.value)} disabled={auto} step={1} precision={0} min={0} onCommit={(value) => setD({ value })} />
              </div>
              <Checkbox checked={auto} onChange={(on) => setD({ flags: setBit(d.flags, 0, !on) })} label="Automatic" />
            </div>
          </Field>
          <Field label="Weight">
            <Num value={data.weight} step={0.1} precision={2} min={0} onCommit={(weight) => commit({ ...data, weight })} />
          </Field>
          <Field label="Sound when used" title="Played when it's drunk or eaten, e.g. ITMPotionUse or ITMFoodEat.">
            <FormPicker value={d.consumeSound ?? null} sigs={['SNDR']} onChange={(consumeSound) => setD({ consumeSound })} />
          </Field>
          <Field label="Addiction" title="A disease-like spell the drinker may catch (like skooma). Leave empty for none.">
            <FormPicker value={d.addiction ?? null} sigs={['SPEL']} onChange={(addiction) => setD({ addiction })} />
          </Field>
        </div>
      </Pad>
      <EffectsEditor value={data.effects} onChange={(effects) => commit({ ...data, effects })} help="What it does when consumed (or, for poisons, to whoever is hit)." />
    </>
  );
}

function IngredientEditor({ data, commit }: EditorProps) {
  const d = data.data ?? {};
  const ing = data.ingredient ?? {};
  return (
    <>
      <Pad>
        <div className="catalog-grid2">
          <NameField data={data} commit={commit} />
          <Field label="Value (gold)">
            <Num value={d.value} min={0} onCommit={(value) => commit({ ...data, data: { ...d, value } })} />
          </Field>
          <Field label="Weight">
            <Num value={d.weight} step={0.1} precision={2} min={0} onCommit={(weight) => commit({ ...data, data: { ...d, weight } })} />
          </Field>
          <Field label="Can be eaten" title="Eating it reveals its first effect, like vanilla ingredients that are food.">
            <Checkbox checked={bit(ing.flags, 1)} onChange={(on) => commit({ ...data, ingredient: { ...ing, flags: setBit(ing.flags, 1, on) } })} label="Food" />
          </Field>
        </div>
      </Pad>
      <EffectsEditor value={data.effects} onChange={(effects) => commit({ ...data, effects })} help="Ingredients have four effects, discovered by eating them or mixing potions. Two ingredients that share an effect make a potion of it." />
    </>
  );
}

// ------------------------------------------------------------------ leveled lists

const LIST_SIGS: Record<string, string[]> = {
  LVLI: ['ARMO', 'AMMO', 'APPA', 'MISC', 'WEAP', 'BOOK', 'LVLI', 'KEYM', 'ALCH', 'INGR', 'LIGH', 'SLGM', 'SCRL'],
  LVSP: ['SPEL', 'LVSP'],
  LVLN: ['NPC_', 'LVLN'],
};

function LeveledListEditor({ view, data, commit }: EditorProps) {
  const entries: Data[] = data.entries ?? [];
  const what = view.sig === 'LVSP' ? 'spell' : view.sig === 'LVLN' ? 'character' : 'item';
  const set = (i: number, patch: Data) => commit({ ...data, entries: entries.map((e, j) => (j === i ? { ...e, entry: { ...e.entry, ...patch } } : e)) });
  const add = () => {
    const next = [...entries, { entry: { level: 1, reference: null, count: 1 } }];
    next.sort((a, b) => num(a.entry?.level) - num(b.entry?.level));
    commit({ ...data, entries: next });
  };
  const f = data.flags;
  return (
    <Pad>
      <div className="catalog-grid2">
        <Field label="Chance of nothing (%)" title="The chance that the list gives nothing at all, in percent.">
          <Slider value={num(data.chanceNone)} min={0} max={100} step={1} onCommit={(chanceNone) => commit({ ...data, chanceNone: Math.round(chanceNone) })} />
        </Field>
        {view.sig !== 'LVSP' && (
          <Field label="…or from a global" title="Use a global variable for the chance instead, so a script or setting can change it.">
            <FormPicker value={data.global ?? null} sigs={['GLOB']} onChange={(global) => commit({ ...data, global })} />
          </Field>
        )}
      </div>
      <div className="col" style={{ gap: 4, margin: '6px 0 10px' }}>
        <Checkbox checked={bit(f, 0)} onChange={(on) => commit({ ...data, flags: setBit(f, 0, on) })} label={`Pick from every level up to the player's`} help={`Off: only the highest-level ${what}s the player qualifies for are picked from. On: anything at or below the player's level can come up.`} />
        <Checkbox checked={bit(f, 1)} onChange={(on) => commit({ ...data, flags: setBit(f, 1, on) })} label="Pick again for each one in a count" help="When the list is asked for several (like 3 from a container), pick each one separately instead of 3 of the same." />
        {view.sig !== 'LVLN' && <Checkbox checked={bit(f, 2)} onChange={(on) => commit({ ...data, flags: setBit(f, 2, on) })} label={`Give everything in the list`} help="Instead of picking one, give every entry the player qualifies for." />}
      </div>
      <Section
        title={<Title help={`Each ${what} becomes possible from its level on. Add the same ${what} twice to make it more likely.`}>{`Entries (${entries.length})`}</Title>}
        actions={
          <button className="btn small" onClick={add} data-testid="add-entry">
            <Icon name="plus" size={12} /> Add {what}
          </button>
        }
      >
        {!entries.length && <div className="faint small">Nothing in this list yet. Add a {what}, then set the level it starts appearing at.</div>}
        {entries.length > 0 && (
          <table className="grid catalog-table">
            <thead>
              <tr>
                <th style={{ width: 80 }}>From level</th>
                <th>{what[0]!.toUpperCase() + what.slice(1)}</th>
                <th style={{ width: 80 }}>Count</th>
                <th style={{ width: 30 }} />
              </tr>
            </thead>
            <tbody>
              {entries.map((e, i) => (
                <tr key={i}>
                  <td>
                    <Num value={e.entry?.level} min={1} onCommit={(level) => set(i, { level })} />
                  </td>
                  <td>
                    <FormPicker value={e.entry?.reference ?? null} sigs={LIST_SIGS[view.sig]} onChange={(reference) => set(i, { reference })} />
                  </td>
                  <td>
                    <Num value={e.entry?.count} min={1} onCommit={(count) => set(i, { count })} />
                  </td>
                  <td>
                    <button className="btn icon ghost" title="Remove" onClick={() => commit({ ...data, entries: entries.filter((_, j) => j !== i) })}>
                      <Icon name="close" size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </Pad>
  );
}

// ------------------------------------------------------------------ crafting recipes

const CRAFTABLE = ['ARMO', 'WEAP', 'AMMO', 'MISC', 'ALCH', 'INGR', 'BOOK', 'SLGM', 'SCRL', 'KEYM', 'APPA', 'LIGH', 'FURN', 'STAT', 'MSTT', 'CONT', 'ACTI'];
const COMPONENTS = ['MISC', 'INGR', 'ALCH', 'ARMO', 'WEAP', 'AMMO', 'SLGM', 'BOOK', 'KEYM', 'LVLI', 'SCRL', 'APPA', 'LIGH'];

function RecipeEditor({ data, commit }: EditorProps) {
  const client = useStore((s) => s.client);
  const { data: benches } = useQuery(() => client?.call('workbenches'), [client], { revision: false });
  const sums = useSummaries([data.workbench]);
  const items: Data[] = data.items ?? [];
  const known = benches ?? [];
  const cur = data.workbench as FormKey | null | undefined;
  const benchOptions = [{ value: '', label: 'None' }, ...known.map((b) => ({ value: b.key as string, label: b.label }))];
  if (cur && !known.some((b) => b.key === cur)) benchOptions.push({ value: cur, label: sums[cur]?.editorId ?? cur });
  const setItem = (i: number, patch: Data) => commit({ ...data, items: items.map((x, j) => (j === i ? { ...x, item: { ...x.item, ...patch } } : x)) });
  const conds: Data[] = data.conditions ?? [];
  return (
    <Pad>
      <div className="catalog-grid2">
        <Field label="Makes" title="The item made, or (at a grindstone or armor workbench) the item improved.">
          <FormPicker value={data.createdObject ?? null} sigs={CRAFTABLE} onChange={(createdObject) => commit({ ...data, createdObject })} placeholder="Choose what it makes…" />
        </Field>
        <Field label="How many">
          <Num value={data.createdCount ?? 1} min={1} onCommit={(createdCount) => commit({ ...data, createdCount })} />
        </Field>
        <Field label="Made at" title="The crafting station. Grindstone and armor workbench recipes improve (temper) an item instead of making a new one.">
          <Select value={(cur ?? '') as string} options={benchOptions} onChange={(v) => commit({ ...data, workbench: v || null })} />
        </Field>
      </div>
      <Section
        title={<Title help="Everything making it uses up. For improving, this is the material used per step.">{`Uses (${items.length})`}</Title>}
        actions={
          <button className="btn small" onClick={() => commit({ ...data, items: [...items, { item: { item: null, count: 1 } }] })} data-testid="add-component">
            <Icon name="plus" size={12} /> Add component
          </button>
        }
      >
        {!items.length && <div className="faint small">Nothing yet: add the materials it needs (like an Iron Ingot and a Leather Strip).</div>}
        {items.map((it, i) => (
          <div key={i} className="row" style={{ gap: 6, marginBottom: 4 }}>
            <div className="grow">
              <FormPicker value={it.item?.item ?? null} sigs={COMPONENTS} onChange={(item) => setItem(i, { item })} placeholder="Choose a component…" />
            </div>
            <div style={{ width: 70 }}>
              <Num value={it.item?.count ?? 1} min={1} onCommit={(count) => setItem(i, { count })} />
            </div>
            <button className="btn icon ghost" title="Remove" onClick={() => commit({ ...data, items: items.filter((_, j) => j !== i) })}>
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </Section>
      <Section title={<Title help="When the recipe shows up, e.g. HasPerk SteelSmithing == 1 so it needs the perk, or GetItemCount on the item so it only shows when you have one to improve.">{`Only when… (${conds.length})`}</Title>}>
        <ConditionList items={conds as any} onChange={(c) => commit({ ...data, conditions: c.length ? c : undefined })} />
      </Section>
    </Pad>
  );
}

// ------------------------------------------------------------------ perks

/** Which kind of value an entry point function takes (the EPFT parameter type). */
const FUNCTION_PARAM: Record<number, number> = { 1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 0, 7: 0, 8: 3, 9: 4, 10: 5, 11: 6, 12: 2, 13: 2, 14: 2, 15: 7 };
const FUNCTION_LABEL: Record<number, string> = {
  1: 'Set to',
  2: 'Add',
  3: 'Multiply by',
  4: 'Add a random amount between',
  5: 'Add a multiple of an actor value',
  6: 'Make positive',
  7: 'Make negative',
  8: 'Add leveled list',
  9: 'Add an activate choice',
  10: 'Cast a spell',
  11: 'Choose text',
  12: 'Set to a multiple of an actor value',
  13: 'Multiply by a multiple of an actor value',
  14: 'Multiply by 1 + a multiple of an actor value',
  15: 'Set text',
};
const ENTRY_POINT_OPTIONS = Object.entries(ENTRY_POINTS)
  .map(([v, l]) => ({ value: Number(v), label: l }))
  .sort((a, b) => a.label.localeCompare(b.label));

function perkSentence(e: Data, names: Record<string, { name?: string; editorId?: string } | null>): string {
  const t = num(e.header?.type);
  const n = (k: unknown) => (typeof k === 'string' ? (names[k]?.name ?? names[k]?.editorId ?? '?') : 'nothing yet');
  if (t === 0) return `Sets ${n(e.data?.quest)} to stage ${num(e.data?.stage)}`;
  if (t === 1) return `Gives the ability ${n(e.data?.ability)}`;
  const ep = ENTRY_POINTS[num(e.data?.entryPoint)] ?? 'Entry point';
  const fn = FUNCTION_LABEL[num(e.data?.function)] ?? ENTRY_FUNCTIONS[num(e.data?.function)] ?? '';
  const p = e.function?.data ?? {};
  const val = p.value !== undefined ? ` ${round(p.value)}` : p.leveledItem ? ` ${n(p.leveledItem)}` : p.spell ? ` ${n(p.spell)}` : p.text ? ` "${p.text}"` : '';
  return `${ep}: ${fn.toLowerCase()}${val}`;
}
const round = (v: unknown) => Math.round(num(v) * 1000) / 1000;

function PerkEffect({ e, onChange, onRemove, tabs, names }: { e: Data; onChange: (e: Data) => void; onRemove: () => void; tabs: Record<number, number>; names: Record<string, any> }) {
  const t = num(e.header?.type);
  const setType = (type: number) => {
    const header = { ...(e.header ?? { rank: 0, priority: 0 }), type };
    if (type === 0) onChange({ header, data: { quest: null, stage: 10 }, end: true });
    else if (type === 1) onChange({ header, data: { ability: null }, end: true });
    else onChange({ header, data: { entryPoint: 35, function: 3, conditionTabs: tabs[35] ?? 3 }, function: { functionType: 1, data: { value: 1.1 } }, end: true });
  };
  const fn = num(e.data?.function);
  const param = FUNCTION_PARAM[fn] ?? 0;
  const setFunction = (f: number) => {
    const p = FUNCTION_PARAM[f] ?? 0;
    const defaults: Record<number, Data | undefined> = { 0: undefined, 1: { value: 1 }, 2: { actorValue: 0, value: 1 }, 3: { leveledItem: null }, 4: { spell: null }, 5: { spell: null }, 6: { text: '' }, 7: { text: '' } };
    onChange({ ...e, data: { ...e.data, function: f }, function: p ? { functionType: p, data: defaults[p] } : undefined });
  };
  const fd = e.function?.data ?? {};
  const setFd = (patch: Data) => onChange({ ...e, function: { ...e.function, functionType: param, data: { ...fd, ...patch } } });
  const condTabs: Data[] = e.conditionTabs ?? [];
  const maxTabs = num(e.data?.conditionTabs, 1);
  return (
    <div className="card catalog-effect" data-testid="perk-effect">
      <div className="row" style={{ gap: 6 }}>
        <div className="grow">
          <Select
            value={t}
            options={[
              { value: 2, label: 'Change a game value (entry point)' },
              { value: 1, label: 'Give an ability' },
              { value: 0, label: 'Set a quest stage' },
            ]}
            onChange={setType}
          />
        </div>
        <button className="btn icon ghost" title="Remove this effect" onClick={onRemove}>
          <Icon name="close" size={12} />
        </button>
      </div>
      {t === 0 && (
        <div className="catalog-grid2">
          <Field label="Quest">
            <FormPicker value={e.data?.quest ?? null} sigs={['QUST']} onChange={(quest) => onChange({ ...e, data: { ...e.data, quest } })} />
          </Field>
          <Field label="Stage">
            <Num value={e.data?.stage} min={0} max={255} onCommit={(stage) => onChange({ ...e, data: { ...e.data, stage } })} />
          </Field>
        </div>
      )}
      {t === 1 && (
        <Field label="Ability" title="An always-on spell (an ability) given while the perk is held, e.g. a bonus to a skill.">
          <FormPicker value={e.data?.ability ?? null} sigs={['SPEL']} onChange={(ability) => onChange({ ...e, data: { ...e.data, ability } })} />
        </Field>
      )}
      {t === 2 && (
        <>
          <div className="catalog-grid2">
            <Field label="What it changes" title="The game calculation this perk hooks into, like the damage of an attack or the price of an item.">
              <Select value={num(e.data?.entryPoint)} options={ENTRY_POINT_OPTIONS} onChange={(entryPoint) => onChange({ ...e, data: { ...e.data, entryPoint, conditionTabs: tabs[entryPoint] ?? e.data?.conditionTabs ?? 1 } })} />
            </Field>
            <Field label="How">
              <Select value={fn} options={Object.entries(FUNCTION_LABEL).map(([v, l]) => ({ value: Number(v), label: l }))} onChange={setFunction} />
            </Field>
          </div>
          {param === 1 && (
            <Field label="Value" title="e.g. 1.2 with Multiply means 20% more.">
              <Num value={fd.value} step={0.05} precision={3} onCommit={(value) => setFd({ value })} />
            </Field>
          )}
          {param === 2 && (
            <div className="catalog-grid2">
              <Field label={fn === 4 ? 'From' : 'Actor value'} title={fn === 4 ? 'The lowest amount added.' : 'Which actor value the multiple is of.'}>
                {fn === 4 ? (
                  <Num value={fd.actorValue} step={0.05} precision={3} onCommit={(actorValue) => setFd({ actorValue })} />
                ) : (
                  <Select value={num(fd.actorValue)} options={ALL_ACTOR_VALUES} onChange={(actorValue) => setFd({ actorValue })} />
                )}
              </Field>
              <Field label={fn === 4 ? 'To' : 'Multiple'}>
                <Num value={fd.value} step={0.05} precision={3} onCommit={(value) => setFd({ value })} />
              </Field>
            </div>
          )}
          {param === 3 && (
            <Field label="Leveled list">
              <FormPicker value={fd.leveledItem ?? null} sigs={['LVLI']} onChange={(leveledItem) => setFd({ leveledItem })} />
            </Field>
          )}
          {(param === 4 || param === 5) && (
            <Field label="Spell">
              <FormPicker value={fd.spell ?? null} sigs={['SPEL']} onChange={(spell) => setFd({ spell })} />
            </Field>
          )}
          {param === 4 && (
            <Field label="Button text" title="The text of the extra choice when activating, e.g. 'Harvest'.">
              <TextInput value={String(e.function?.buttonLabel ?? '')} onCommit={(buttonLabel) => onChange({ ...e, function: { ...e.function, buttonLabel } })} />
            </Field>
          )}
          {(param === 6 || param === 7) && (
            <Field label="Text">
              <TextInput value={String(fd.text ?? '')} onCommit={(text) => setFd({ text })} />
            </Field>
          )}
          <details>
            <summary className="small dim" style={{ cursor: 'pointer' }}>
              Only when… ({condTabs.reduce((n, c) => n + (c.conditions?.length ?? 0), 0)}){' '}
              <Help text="Conditions on this effect. Tab 1 tests the perk's owner; the other tabs test the other things involved, which depend on what it changes (usually the item, weapon or spell, then the target)." />
            </summary>
            {condTabs.map((ct, i) => (
              <div key={i} className="catalog-subcard">
                <div className="row small dim" style={{ gap: 6 }}>
                  <span className="grow">Tests {num(ct.runOn) === 0 ? 'the perk owner' : `subject ${num(ct.runOn) + 1}`}</span>
                  <Select value={num(ct.runOn)} options={Array.from({ length: Math.max(maxTabs, num(ct.runOn) + 1) }, (_, k) => ({ value: k, label: k === 0 ? 'Perk owner' : `Subject ${k + 1}` }))} onChange={(runOn) => onChange({ ...e, conditionTabs: condTabs.map((x, j) => (j === i ? { ...x, runOn } : x)) })} />
                </div>
                <ConditionList items={(ct.conditions ?? []) as any} onChange={(c) => onChange({ ...e, conditionTabs: condTabs.map((x, j) => (j === i ? { ...x, conditions: c } : x)).filter((x) => (x.conditions ?? []).length) })} />
              </div>
            ))}
            <button className="btn small ghost" onClick={() => onChange({ ...e, conditionTabs: [...condTabs, { runOn: 0, conditions: [] }] })}>
              <Icon name="plus" size={12} /> Add conditions
            </button>
          </details>
        </>
      )}
      <div className="small dim">{perkSentence(e, names)}</div>
    </div>
  );
}

function PerkEditor({ data, commit }: EditorProps) {
  const client = useStore((s) => s.client);
  const { data: tabs } = useQuery(() => client?.call('perkEntryPointTabs'), [client], { revision: false });
  const d = data.data ?? {};
  const effects: Data[] = data.effects ?? [];
  const names = useSummaries(effects.flatMap((e) => [e.data?.quest, e.data?.ability, e.function?.data?.spell, e.function?.data?.leveledItem]));
  const conds: Data[] = data.conditions ?? [];
  return (
    <>
      <Pad>
        <div className="catalog-grid2">
          <NameField data={data} commit={commit} />
          <Field label="Next rank" title="The perk that follows this one in its skill tree (the next rank, like Armsman 2/5).">
            <FormPicker value={data.nextPerk ?? null} sigs={['PERK']} onChange={(nextPerk) => commit({ ...data, nextPerk })} />
          </Field>
        </div>
        <Field label="Description" title="Shown in the skill tree." stack>
          <TextInput value={String(data.description ?? '')} multiline onCommit={(description) => commit({ ...data, description })} />
        </Field>
        <div className="row wrap" style={{ gap: 12, marginTop: 6 }}>
          <Checkbox checked={!!num(d.playable)} onChange={(on) => commit({ ...data, data: { ...d, playable: on ? 1 : 0 } })} label="The player can take it" help="Shown in a skill tree so the player can pick it. Off for perks only characters or scripts give." />
          <Checkbox checked={!!num(d.hidden)} onChange={(on) => commit({ ...data, data: { ...d, hidden: on ? 1 : 0 } })} label="Hidden" help="Not listed in the active effects." />
        </div>
      </Pad>
      <Pad>
        <Section title={<Title help="What's needed to take it, e.g. GetBaseActorValue OneHanded >= 30, and HasPerk Armsman20 for the previous rank.">{`Requirements (${conds.length})`}</Title>}>
          <ConditionList items={conds as any} onChange={(c) => commit({ ...data, conditions: c.length ? c : undefined })} />
        </Section>
      </Pad>
      <Pad>
        <Section
          title={<Title help="What the perk does: change a game calculation (an entry point, like weapon damage or prices), give an always-on ability, or set a quest stage.">{`Effects (${effects.length})`}</Title>}
          actions={
            <button
              className="btn small"
              data-testid="add-perk-effect"
              onClick={() => commit({ ...data, effects: [...effects, { header: { type: 2, rank: 0, priority: 0 }, data: { entryPoint: 35, function: 3, conditionTabs: tabs?.[35] ?? 3 }, function: { functionType: 1, data: { value: 1.2 } }, end: true }] })}
            >
              <Icon name="plus" size={12} /> Add effect
            </button>
          }
        >
          {!effects.length && <div className="faint small">No effects yet. Add one, like "Mod Attack Damage: multiply by 1.2" for 20% more damage.</div>}
          {effects.map((e, i) => (
            <PerkEffect key={i} e={e} tabs={tabs ?? {}} names={names} onChange={(n) => commit({ ...data, effects: effects.map((x, j) => (j === i ? n : x)) })} onRemove={() => commit({ ...data, effects: effects.filter((_, j) => j !== i) })} />
          ))}
        </Section>
      </Pad>
    </>
  );
}

// ------------------------------------------------------------------ magic effects, shouts, words

const SCHOOL_OPTIONS = [-1, 18, 19, 20, 21, 22].map((v) => ({ value: v, label: v < 0 ? 'None' : ACTOR_VALUE_LABEL(v) }));
const RESIST_OPTIONS = [-1, 39, 40, 41, 42, 43, 44, 45].map((v) => ({ value: v, label: v < 0 ? 'Nothing' : ACTOR_VALUE_LABEL(v) }));
const LEVEL_OPTIONS = [0, 25, 50, 75, 100].map((v, i) => ({ value: v, label: ['Novice', 'Apprentice', 'Adept', 'Expert', 'Master'][i]! }));
const MGEF_FLAG_CHOICES: [number, string, string][] = [
  [0, 'Hostile', 'Counts as an attack: makes the target hostile and can be a crime.'],
  [2, 'Harmful', 'Lowers a value (damage) instead of raising it.'],
  [1, 'Wears off', 'The value goes back when the effect ends (like Fortify), instead of staying (like Restore).'],
  [9, 'No duration', 'Hides the duration in menus.'],
  [10, 'No strength', 'Hides the strength (magnitude) in menus.'],
  [11, 'No area', 'Hides the area in menus.'],
  [15, 'Hidden in menus', 'Not shown in the active effects list.'],
  [26, 'Painless', 'No hit reaction when it lands.'],
  [21, 'Skill raises strength', 'The caster\'s skill and perks scale the strength.'],
  [22, 'Skill raises duration', 'The caster\'s skill and perks scale the duration.'],
];

function MagicEffectEditor({ data, commit }: EditorProps) {
  const d = data.data ?? {};
  const setD = (patch: Data) => commit({ ...data, data: { ...d, ...patch } });
  return (
    <Pad>
      <div className="catalog-grid2">
        <NameField data={data} commit={commit} />
        <Field label="What it does" title="The game mechanic: change an actor value, run a script, summon a creature, paralyze, light, open a lock…">
          <Select value={num(d.archetype)} options={Object.entries(ARCHETYPES).map(([v, l]) => ({ value: Number(v), label: l }))} onChange={(archetype) => setD({ archetype })} />
        </Field>
        <Field label="Changes" title="The actor value it raises or lowers, e.g. Health for damage and healing, or a skill for Fortify effects.">
          <Select value={num(d.actorValue, -1)} options={ALL_ACTOR_VALUES} onChange={(actorValue) => setD({ actorValue })} />
        </Field>
        <Field label="School" title="The magic school; casting it trains that skill and its perks apply.">
          <Select value={num(d.magicSkill, -1)} options={SCHOOL_OPTIONS.some((o) => o.value === num(d.magicSkill, -1)) ? SCHOOL_OPTIONS : [...SCHOOL_OPTIONS, { value: num(d.magicSkill), label: ACTOR_VALUE_LABEL(num(d.magicSkill)) }]} onChange={(magicSkill) => setD({ magicSkill })} />
        </Field>
        <Field label="Resisted by" title="Which resistance lowers its strength on the target.">
          <Select value={num(d.resistValue, -1)} options={RESIST_OPTIONS.some((o) => o.value === num(d.resistValue, -1)) ? RESIST_OPTIONS : [...RESIST_OPTIONS, { value: num(d.resistValue), label: ACTOR_VALUE_LABEL(num(d.resistValue)) }]} onChange={(resistValue) => setD({ resistValue })} />
        </Field>
        <Field label="Spell level" title="The level a spell using it counts as (which perks reduce its cost).">
          <Select value={num(d.minimumSkillLevel)} options={LEVEL_OPTIONS.some((o) => o.value === num(d.minimumSkillLevel)) ? LEVEL_OPTIONS : [...LEVEL_OPTIONS, { value: num(d.minimumSkillLevel), label: String(num(d.minimumSkillLevel)) }]} onChange={(minimumSkillLevel) => setD({ minimumSkillLevel })} />
        </Field>
        <Field label="Casting" title="Must match the spells that use it.">
          <Select value={num(d.castingType)} options={[...CASTING, { value: 3, label: 'Scroll' }]} onChange={(castingType) => setD({ castingType })} />
        </Field>
        <Field label="Target" title="Must match the spells that use it.">
          <Select value={num(d.delivery)} options={TARGETS} onChange={(delivery) => setD({ delivery })} />
        </Field>
        <Field label="Base cost" title="Used to work out the cost of spells, potions and enchantments with automatic cost.">
          <Num value={d.baseCost} step={0.1} precision={2} min={0} onCommit={(baseCost) => setD({ baseCost })} />
        </Field>
        <Field label="Uses" title="Depends on what it does: the creature to summon, the weapon to bind, the light to cast, the keyword…">
          <FormPicker value={d.associatedItem ?? null} onChange={(associatedItem) => setD({ associatedItem })} />
        </Field>
      </div>
      <Field label="Description" title="Shown for spells and potions using it. <mag> and <dur> are replaced by the strength and duration." stack>
        <TextInput value={String(data.description ?? '')} multiline onCommit={(description) => commit({ ...data, description })} />
      </Field>
      <div className="catalog-flags">
        {MGEF_FLAG_CHOICES.map(([b, label, help]) => (
          <Checkbox key={b} checked={bit(d.flags, b)} onChange={(on) => setD({ flags: setBit(d.flags, b, on) })} label={label} help={help} />
        ))}
      </div>
      <div className="faint small" style={{ marginTop: 8 }}>
        Visuals and sounds (projectile, hit shader, casting art) are under "Show every field".
      </div>
    </Pad>
  );
}

function ShoutEditor({ data, commit }: EditorProps) {
  const words: Data[] = data.words ?? [];
  const set = (i: number, patch: Data) => commit({ ...data, words: words.map((w, j) => (j === i ? { ...w, ...patch } : w)) });
  return (
    <Pad>
      <NameField data={data} commit={commit} />
      <Field label="Description" stack>
        <TextInput value={String(data.description ?? '')} multiline onCommit={(description) => commit({ ...data, description })} />
      </Field>
      <Section
        title={<Title help="Shouts have up to three words. Each word casts its own spell and has its own cooldown.">Words</Title>}
        actions={
          words.length < 3 ? (
            <button className="btn small" onClick={() => commit({ ...data, words: [...words, { word: null, spell: null, recoveryTime: 10 }] })}>
              <Icon name="plus" size={12} /> Add word
            </button>
          ) : null
        }
      >
        {!words.length && <div className="faint small">No words yet. Add the first word, the spell it casts and its cooldown.</div>}
        {words.length > 0 && (
          <table className="grid catalog-table">
            <thead>
              <tr>
                <th style={{ width: 30 }}>#</th>
                <th>Word</th>
                <th>Spell it casts</th>
                <th style={{ width: 90 }}>Cooldown (s)</th>
                <th style={{ width: 30 }} />
              </tr>
            </thead>
            <tbody>
              {words.map((w, i) => (
                <tr key={i}>
                  <td className="dim">{i + 1}</td>
                  <td>
                    <FormPicker value={w.word ?? null} sigs={['WOOP']} onChange={(word) => set(i, { word })} />
                  </td>
                  <td>
                    <FormPicker value={w.spell ?? null} sigs={['SPEL']} onChange={(spell) => set(i, { spell })} />
                  </td>
                  <td>
                    <Num value={w.recoveryTime} step={1} precision={1} min={0} onCommit={(recoveryTime) => set(i, { recoveryTime })} />
                  </td>
                  <td>
                    <button className="btn icon ghost" title="Remove" onClick={() => commit({ ...data, words: words.filter((_, j) => j !== i) })}>
                      <Icon name="close" size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </Pad>
  );
}

function WordEditor({ data, commit }: EditorProps) {
  return (
    <Pad>
      <div className="catalog-grid2">
        <NameField data={data} commit={commit} label="Word" help="The dragon word as written in game, e.g. Fus." />
        <Field label="Meaning" title="Shown when the word is learned, e.g. Force.">
          <TextInput value={String(data.translation ?? '')} onCommit={(translation) => commit({ ...data, translation })} />
        </Field>
      </div>
    </Pad>
  );
}

// ------------------------------------------------------------------ weapons, armor and other items

const WEAPON_KINDS = ['Hand to hand', 'One-handed sword', 'Dagger', 'One-handed axe', 'Mace', 'Two-handed sword', 'Two-handed axe / warhammer', 'Bow', 'Staff', 'Crossbow'].map((label, value) => ({ value, label }));

function WeaponEditor({ data, commit }: EditorProps) {
  const d = data.data ?? {};
  const st = data.stats ?? {};
  const cr = data.critical ?? {};
  const setD = (patch: Data) => commit({ ...data, data: { ...d, ...patch } });
  const setSt = (patch: Data) => commit({ ...data, stats: { ...st, ...patch } });
  return (
    <>
      <Pad>
        {data.template && <div className="small warn" style={{ marginBottom: 6 }}>This weapon copies its other details from its template (see below).</div>}
        <div className="catalog-grid3">
          <NameField data={data} commit={commit} />
          <Field label="Kind" title="Sets how it's held and swung. Also set the matching WeapType keyword (like WeapTypeSword) so perks recognise it.">
            <Select value={num(st.animationType)} options={WEAPON_KINDS} onChange={(animationType) => setSt({ animationType })} />
          </Field>
          <Field label="Skill" title="The skill it uses and trains.">
            <Select value={num(st.skill, -1)} options={SKILLS} onChange={(skill) => setSt({ skill })} />
          </Field>
          <Field label="Damage">
            <Num value={d.damage} min={0} onCommit={(damage) => setD({ damage })} />
          </Field>
          <Field label="Value (gold)">
            <Num value={d.value} min={0} onCommit={(value) => setD({ value })} />
          </Field>
          <Field label="Weight">
            <Num value={d.weight} step={0.5} precision={1} min={0} onCommit={(weight) => setD({ weight })} />
          </Field>
          <Field label="Speed" title="Swing speed multiplier; 1 is normal.">
            <Num value={st.speed} step={0.05} precision={2} min={0} onCommit={(speed) => setSt({ speed })} />
          </Field>
          <Field label="Reach" title="Reach multiplier; 1 is normal.">
            <Num value={st.reach} step={0.05} precision={2} min={0} onCommit={(reach) => setSt({ reach })} />
          </Field>
          <Field label="Stagger" title="How much a hit staggers the target.">
            <Num value={st.stagger} step={0.05} precision={2} min={0} onCommit={(stagger) => setSt({ stagger })} />
          </Field>
          <Field label="Critical damage" title="Extra damage on a critical hit (sneak attacks and perks).">
            <Num value={cr.damage} min={0} onCommit={(damage) => commit({ ...data, critical: { ...cr, damage } })} />
          </Field>
        </div>
        <div className="catalog-grid2">
          <Field label="Enchantment" title="An enchantment that applies on each hit (weapon enchantments use charge).">
            <FormPicker value={data.enchantment ?? null} sigs={['ENCH']} onChange={(enchantment) => commit({ ...data, enchantment })} />
          </Field>
          <Field label="Charge" title="Enchantment charge it holds (like soul gem capacity).">
            <Num value={data.enchantmentAmount} min={0} onCommit={(enchantmentAmount) => commit({ ...data, enchantmentAmount })} />
          </Field>
          <Field label="Template" title="Copies its look and most details from another weapon; used for enchanted versions of a weapon.">
            <FormPicker value={data.template ?? null} sigs={['WEAP']} onChange={(template) => commit({ ...data, template })} />
          </Field>
        </div>
        <div className="row wrap" style={{ gap: 12, marginTop: 6 }}>
          <Checkbox checked={bit(st.flags, 7)} onChange={(on) => setSt({ flags: setBit(st.flags, 7, on) })} label="Not for the player" help="Hidden from the player's inventory: used only by characters or creatures." />
          <Checkbox checked={bit(st.flags2, 13)} onChange={(on) => setSt({ flags2: setBit(st.flags2, 13, on) })} label="Bound weapon" help="Conjured: disappears when dropped or when the spell ends." />
        </div>
      </Pad>
      <Keywords data={data} commit={commit} help="Tags perks, crafting and scripts look for, like WeapTypeSword, WeapMaterialIron or VendorItemWeapon (so merchants buy it)." />
    </>
  );
}

const SLOTS: Record<number, string> = { 0: 'Head', 1: 'Hair', 2: 'Body', 3: 'Hands', 4: 'Forearms', 5: 'Amulet', 6: 'Ring', 7: 'Feet', 8: 'Calves', 9: 'Shield', 10: 'Tail', 11: 'Long hair', 12: 'Circlet', 13: 'Ears' };

function ArmorEditor({ data, commit }: EditorProps) {
  const d = data.data ?? {};
  const bt = data.bodyTemplate;
  const setBt = (patch: Data) => commit({ ...data, bodyTemplate: { ...bt, ...patch } });
  const slots = num(bt?.slots);
  return (
    <>
      <Pad>
        {data.template && <div className="small warn" style={{ marginBottom: 6 }}>This item copies its other details from its template (see below).</div>}
        <div className="catalog-grid3">
          <NameField data={data} commit={commit} />
          {bt && (
            <Field label="Kind" title="Light and heavy armor use their skills; clothing has no armor skill.">
              <Select
                value={num(bt.armorType)}
                options={[
                  { value: 0, label: 'Light armor' },
                  { value: 1, label: 'Heavy armor' },
                  { value: 2, label: 'Clothing' },
                ]}
                onChange={(armorType) => setBt({ armorType })}
              />
            </Field>
          )}
          <Field label="Armor rating" title="Shown in the inventory before skill and perks.">
            <Num value={num(data.armorRating) / 100} step={1} precision={2} min={0} onCommit={(v) => commit({ ...data, armorRating: Math.round(v * 100) })} />
          </Field>
          <Field label="Value (gold)">
            <Num value={d.value} min={0} onCommit={(value) => commit({ ...data, data: { ...d, value } })} />
          </Field>
          <Field label="Weight">
            <Num value={d.weight} step={0.5} precision={1} min={0} onCommit={(weight) => commit({ ...data, data: { ...d, weight } })} />
          </Field>
          <Field label="Enchantment" title="An enchantment that's on while it's worn.">
            <FormPicker value={data.enchantment ?? null} sigs={['ENCH']} onChange={(enchantment) => commit({ ...data, enchantment })} />
          </Field>
          <Field label="Template" title="Copies its look and most details from another item; used for enchanted versions.">
            <FormPicker value={data.template ?? null} sigs={['ARMO']} onChange={(template) => commit({ ...data, template })} />
          </Field>
        </div>
        {bt && (
          <Section title={<Title help="Which body slots it takes. Two items can't be worn in the same slot at once.">Worn on</Title>}>
            <div className="catalog-flags">
              {Object.entries(SLOTS).map(([b, label]) => (
                <Checkbox key={b} checked={(slots & (1 << Number(b))) !== 0} onChange={(on) => setBt({ slots: setBit(slots, Number(b), on) })} label={label} />
              ))}
            </div>
          </Section>
        )}
        <Section title={<Title help="The meshes it uses for each race (armor addons). Edit them under Records.">Models per race</Title>}>
          <FormList value={data.armatures} sigs={['ARMA']} onChange={(armatures) => commit({ ...data, armatures })} addLabel="Add armor addon" empty="No models: it won't show when worn." />
        </Section>
      </Pad>
      <Keywords data={data} commit={commit} help="Tags perks, crafting and scripts look for, like ArmorCuirass, ArmorMaterialIron or VendorItemArmor (so merchants buy it)." />
    </>
  );
}

function ValueWeight({ data, commit, at = 'data' }: { data: Data; commit: (d: Data) => void; at?: string }) {
  const d = data[at] ?? {};
  return (
    <>
      <Field label="Value (gold)">
        <Num value={d.value} min={0} onCommit={(value) => commit({ ...data, [at]: { ...d, value } })} />
      </Field>
      <Field label="Weight">
        <Num value={d.weight} step={0.1} precision={2} min={0} onCommit={(weight) => commit({ ...data, [at]: { ...d, weight } })} />
      </Field>
    </>
  );
}

function BookEditor({ data, commit }: EditorProps) {
  const d = data.data ?? {};
  const teaches = bit(d.flags, 0) ? 'skill' : bit(d.flags, 2) ? 'spell' : 'nothing';
  const setTeaches = (t: string) => commit({ ...data, data: { ...d, flags: setBit(setBit(d.flags, 0, t === 'skill'), 2, t === 'spell'), teaches: t === 'skill' ? 6 : t === 'spell' ? null : 0 } });
  return (
    <>
      <Pad>
        <div className="catalog-grid3">
          <NameField data={data} commit={commit} />
          <ValueWeight data={data} commit={commit} />
          <Field label="Reading it teaches" title="Skill books raise a skill the first time they're read; spell tomes teach a spell and are used up.">
            <Select
              value={teaches}
              options={[
                { value: 'nothing', label: 'Nothing' },
                { value: 'skill', label: 'A skill' },
                { value: 'spell', label: 'A spell' },
              ]}
              onChange={setTeaches}
            />
          </Field>
          {teaches === 'skill' && (
            <Field label="Skill">
              <Select value={num(d.teaches)} options={SKILLS.filter((s) => s.value >= 0)} onChange={(v) => commit({ ...data, data: { ...d, teaches: v } })} />
            </Field>
          )}
          {teaches === 'spell' && (
            <Field label="Spell">
              <FormPicker value={typeof d.teaches === 'string' ? d.teaches : null} sigs={['SPEL']} onChange={(v) => commit({ ...data, data: { ...d, teaches: v } })} />
            </Field>
          )}
          <Field label="Can't be taken" title="It can be read where it lies but not picked up.">
            <Checkbox checked={bit(d.flags, 1)} onChange={(on) => commit({ ...data, data: { ...d, flags: setBit(d.flags, 1, on) } })} label="" />
          </Field>
        </div>
        <Field label="Text" title="What the book says. It can use the game's book tags like <p align='center'> and [pagebreak]." stack>
          <TextInput value={String(data.text ?? '')} multiline onCommit={(text) => commit({ ...data, text })} />
        </Field>
      </Pad>
      <Keywords data={data} commit={commit} help="E.g. VendorItemBook so merchants buy it, or VendorItemSpellTome for spell tomes." />
    </>
  );
}

function SimpleItemEditor({ view, data, commit }: EditorProps) {
  const d = data.data ?? {};
  return (
    <>
      <Pad>
        <div className="catalog-grid3">
          <NameField data={data} commit={commit} />
          <ValueWeight data={data} commit={commit} />
          {view.sig === 'AMMO' && (
            <>
              <Field label="Damage">
                <Num value={d.damage} step={1} precision={1} min={0} onCommit={(damage) => commit({ ...data, data: { ...d, damage } })} />
              </Field>
              <Field label="Kind">
                <Select
                  value={bit(d.flags, 2) ? 'arrow' : 'bolt'}
                  options={[
                    { value: 'arrow', label: 'Arrow' },
                    { value: 'bolt', label: 'Bolt' },
                  ]}
                  onChange={(k) => commit({ ...data, data: { ...d, flags: setBit(d.flags, 2, k === 'arrow') } })}
                />
              </Field>
              <Field label="Projectile" title="The flying arrow or bolt and how fast it goes.">
                <FormPicker value={d.projectile ?? null} sigs={['PROJ']} onChange={(projectile) => commit({ ...data, data: { ...d, projectile } })} />
              </Field>
            </>
          )}
          {view.sig === 'SLGM' && (
            <>
              <Field label="Holds" title="The largest soul it can hold.">
                <Select value={num(data.capacity)} options={['None', 'Petty', 'Lesser', 'Common', 'Greater', 'Grand'].map((label, value) => ({ value, label }))} onChange={(capacity) => commit({ ...data, capacity })} />
              </Field>
              <Field label="Contains" title="The soul it starts with.">
                <Select value={num(data.soul)} options={['Empty', 'Petty', 'Lesser', 'Common', 'Greater', 'Grand'].map((label, value) => ({ value, label }))} onChange={(soul) => commit({ ...data, soul })} />
              </Field>
              <Field label="Empty version" title="The gem it turns into once its soul is used.">
                <FormPicker value={data.linkedTo ?? null} sigs={['SLGM']} onChange={(linkedTo) => commit({ ...data, linkedTo })} />
              </Field>
            </>
          )}
          {view.sig === 'APPA' && (
            <Field label="Quality" title="Better tools make stronger potions.">
              <Select value={num(data.quality)} options={['Novice', 'Apprentice', 'Journeyman', 'Expert', 'Master'].map((label, value) => ({ value, label }))} onChange={(quality) => commit({ ...data, quality })} />
            </Field>
          )}
        </div>
      </Pad>
      {view.sig !== 'APPA' && <Keywords data={data} commit={commit} help="Tags scripts and merchants look for, like VendorItemGem or VendorItemOreIngot (so merchants buy it)." />}
    </>
  );
}

function OutfitEditor({ data, commit }: EditorProps) {
  return (
    <Pad>
      <Section title={<Title help="What a character wearing this outfit has on. Loot lists pick a piece by level.">{`Pieces (${(data.items ?? []).length})`}</Title>}>
        <FormList value={data.items} sigs={['ARMO', 'LVLI']} onChange={(items) => commit({ ...data, items })} addLabel="Add piece" empty="Nothing in this outfit yet." />
      </Section>
    </Pad>
  );
}

export const FRIENDLY_EDITORS: Record<string, (p: EditorProps) => ReactNode> = {
  SPEL: SpellEditor,
  ENCH: EnchantmentEditor,
  SCRL: ScrollEditor,
  ALCH: PotionEditor,
  INGR: IngredientEditor,
  LVLI: LeveledListEditor,
  LVSP: LeveledListEditor,
  LVLN: LeveledListEditor,
  COBJ: RecipeEditor,
  PERK: PerkEditor,
  MGEF: MagicEffectEditor,
  SHOU: ShoutEditor,
  WOOP: WordEditor,
  WEAP: WeaponEditor,
  ARMO: ArmorEditor,
  BOOK: BookEditor,
  MISC: SimpleItemEditor,
  KEYM: SimpleItemEditor,
  SLGM: SimpleItemEditor,
  AMMO: SimpleItemEditor,
  APPA: SimpleItemEditor,
  OTFT: OutfitEditor,
};
