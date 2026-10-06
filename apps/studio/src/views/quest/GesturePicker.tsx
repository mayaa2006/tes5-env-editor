/** Choose a gesture (an idle animation) by its everyday name. */
import { useQuery } from '../../components/ui';
import { useStore } from '../../state/store';

const GROUPS: Record<string, string> = { greet: 'Greetings', talk: 'While talking', emotion: 'Feelings', action: 'Actions', 'load order': 'Other idles in your load order' };

export function GesturePicker({ value, onChange, none = 'No gesture', testId }: { value: string | null; onChange: (g: string | null) => void; none?: string; testId?: string }) {
  const client = useStore((s) => s.client);
  const { data } = useQuery(() => client?.call('gestures'), [], { revision: false });
  const groups = Object.keys(GROUPS).filter((g) => data?.some((x) => x.group === g));
  const known = !value || data?.some((x) => x.id === value);
  return (
    <select className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)} data-testid={testId} title="An idle animation the character plays">
      <option value="">{none}</option>
      {!known && value && <option value={value}>{value}</option>}
      {groups.map((g) => (
        <optgroup key={g} label={GROUPS[g]}>
          {data!
            .filter((x) => x.group === g)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
                {x.loops ? ' (loops until “Stop”)' : ''}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}
