/**
 * The plan played through before it's built (walkthrough.ts): which endings the player can reach and how, where they
 * can get stuck, and what can never happen.
 */
import { useState } from 'react';
import type { WalkPath, Walkthrough } from '@tes5/workspace';
import { Help, Icon } from '../../components/ui';

function Path({ path }: { path: WalkPath }) {
  if (!path.steps.length) return <span className="dim small">right at the start</span>;
  return (
    <ol className="small dim" style={{ margin: '2px 0 0', paddingLeft: 18 }}>
      {path.steps.map((s, i) => (
        <li key={i} style={{ whiteSpace: 'normal' }}>
          {s}
        </li>
      ))}
    </ol>
  );
}

export function PlayedThrough({ walk }: { walk: Walkthrough }) {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (id: string) => setOpen((o) => (o === id ? null : id));
  const completes = walk.endings.filter((e) => !e.fails);
  const fails = walk.endings.filter((e) => e.fails);
  const row = (id: string, icon: string, title: string, path: WalkPath, tone?: 'warn') => (
    <li key={id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <button className="link-button row" style={{ gap: 6, textAlign: 'left' }} onClick={() => toggle(id)} aria-expanded={open === id} title={open === id ? 'Hide the way there' : 'Show what the player does to get there'}>
        <Icon name={icon} size={12} />
        <span className={tone === 'warn' ? 'warn' : undefined}>{title}</span>
        <span className="dim small">({path.steps.length} step{path.steps.length === 1 ? '' : 's'})</span>
      </button>
      {open === id && <Path path={path} />}
    </li>
  );
  return (
    <div className="card" data-testid="played-through">
      <div className="card-title">
        Played through
        <Help text="Every way the player can go through this plan, tried before anything is built: the steps that can happen at each stage, and the lines whose conditions hold (said to someone who's still there). What the plan can't know about the player, like their Speech or the time of day, is tried both ways. Click an ending to see the shortest way there." />
      </div>
      {walk.partial ? (
        <p className="dim small" style={{ margin: 0 }}>
          This plan has too many ways through to try them all ({walk.states} tried). The quest map still checks every stage can be reached.
        </p>
      ) : (
        <ul className="always-list" data-testid="played-through-list">
          {!completes.length && (
            <li>
              <Icon name="warn" size={12} />
              <span className="warn">No way through completes the quest. Check the stages that complete it, and what leads there.</span>
            </li>
          )}
          {completes.map((e) => row(`end${e.stage}`, 'check', `Completes at stage ${e.stage}${e.journal ? `: “${e.journal.slice(0, 80)}${e.journal.length > 80 ? '…' : ''}”` : ''}`, e.path))}
          {fails.map((e) => row(`fail${e.stage}`, 'close', `Fails at stage ${e.stage}${e.journal ? `: “${e.journal.slice(0, 80)}${e.journal.length > 80 ? '…' : ''}”` : ''}`, e.path))}
          {walk.stuck.map((s) => row(`stuck${s.stage}`, 'warn', `Can get stuck at stage ${s.stage}: nothing the player can do moves it on`, s.path, 'warn'))}
          {walk.unreached.length > 0 && (
            <li>
              <Icon name="warn" size={12} />
              <span className="warn">
                Never reached: stage{walk.unreached.length === 1 ? '' : 's'} {walk.unreached.join(', ')}
              </span>
            </li>
          )}
          {walk.unsaid.length > 0 && (
            <li style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <button className="link-button row" style={{ gap: 6, textAlign: 'left' }} onClick={() => toggle('unsaid')} aria-expanded={open === 'unsaid'} title="Lines that set a stage but whose conditions never hold on any way through">
                <Icon name="warn" size={12} />
                <span className="warn">
                  {walk.unsaid.length} line{walk.unsaid.length === 1 ? '' : 's'} that move the quest on can never be said
                </span>
              </button>
              {open === 'unsaid' && (
                <ul className="small dim" style={{ margin: '2px 0 0', paddingLeft: 18 }}>
                  {walk.unsaid.map((l) => (
                    <li key={l} style={{ whiteSpace: 'normal' }}>
                      {l}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
