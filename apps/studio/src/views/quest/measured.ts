import { useCallback, useState } from 'react';
import type { Node, NodeChange } from '@xyflow/react';

/**
 * Controlled React Flow graphs must hand node sizes back to the library. If
 * the node array is rebuilt after the first measurement (e.g. a name loads
 * late) without them, React Flow forgets the size and leaves the node hidden.
 */
export function useMeasured() {
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const onChanges = useCallback((changes: NodeChange[]) => {
    const dims = changes.filter((c) => c.type === 'dimensions' && c.dimensions);
    if (!dims.length) return;
    setMeasured((cur) => {
      const next = { ...cur };
      for (const c of dims) if (c.type === 'dimensions' && c.dimensions) next[c.id] = c.dimensions;
      return next;
    });
  }, []);
  const withSize = useCallback(<N extends Node>(n: N): N => (measured[n.id] ? { ...n, measured: measured[n.id] } : n), [measured]);
  return { onChanges, withSize };
}
