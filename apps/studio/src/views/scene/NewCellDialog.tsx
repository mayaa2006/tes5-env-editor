import { useState } from 'react';
import { Field, Modal, TextInput, useUniqueEditorId } from '../../components/ui';
import { engine, useStore } from '../../state/store';

export function NewCellDialog({ onClose }: { onClose: () => void }) {
  const [edid, setEdid] = useUniqueEditorId('MyNewInterior');
  const [name, setName] = useState('');
  return (
    <Modal
      title="New interior cell"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              const key = await engine((c) => c.call('createInteriorCell', edid, name || undefined), { success: `Created ${edid}` });
              if (key) {
                useStore.getState().setCell(key);
                onClose();
              }
            }}
          >
            Create
          </button>
        </>
      }
    >
      <Field label="Editor ID">
        <TextInput value={edid} onCommit={setEdid} autoFocus mono />
      </Field>
      <Field label="Name">
        <TextInput value={name} onCommit={setName} placeholder="Shown in game when entering" />
      </Field>
      <p className="dim small">Lighting, ownership and the rest can be edited in the properties panel once it's created. Drag objects from the Objects or Assets tab to build it.</p>
    </Modal>
  );
}
