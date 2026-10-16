/**
 * "Ask the AI" from any workspace: a small menu of questions about what's
 * open there. Picking one opens the AI tab with the question ready to send
 * (and "Include what I have open" tells the AI which record it's about).
 */
import { Icon, Menu, MenuItem } from './ui';
import type { FormKey } from '@tes5/esp';
import { useStore } from '../state/store';

export function AskAiButton({ what, questions, form, align = 'left' }: { what: string; questions: string[]; form?: FormKey; align?: 'left' | 'right' }) {
  const ask = (text: string) => {
    // The record becomes the selected one, so the AI is told which it is.
    if (form) useStore.getState().select(form);
    useStore.getState().askAi(text);
  };
  return (
    <div className={align === 'right' ? 'menu-right' : undefined}>
      <Menu
        label={
          <>
            <Icon name="ai" size={12} /> Ask the AI
          </>
        }
        title={`Ask the AI about ${what}: the AI tab opens with the question ready to send, and knows what you have open`}
        testId="ask-ai"
      >
        {(close) => (
          <>
            {questions.map((q) => (
              <MenuItem
                key={q}
                onClick={() => {
                  close();
                  ask(q);
                }}
              >
                {q}
              </MenuItem>
            ))}
            <MenuItem
              title="Open the AI tab with the start of a question to finish yourself"
              onClick={() => {
                close();
                ask(`About ${what}: `);
              }}
            >
              Write my own question…
            </MenuItem>
          </>
        )}
      </Menu>
    </div>
  );
}
