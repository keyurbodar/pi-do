// Static catalogue of the bloub engine: every shape across the key states,
// then the full expression set. Frozen frames (deterministic, no rAF loops)
// so the board is cheap to render and stable to screenshot.
import Bloub from './Bloub';
import type { BloubExpression, BloubShape } from '../../lib/roster';
import type { ReactNode } from 'react';

const SHAPES: BloubShape[] = [
  'cercle',
  'galet',
  'squircle',
  'capsule',
  'triangle',
  'hexagone',
  'nuage',
  'goutte',
];

const STATES = ['idle', 'thinking', 'alert', 'notify', 'sleep'] as const;

const EXPRESSIONS: BloubExpression[] = [
  'neutre',
  'attentif',
  'surpris',
  'excite',
  'heureux',
  'hilare',
  'colere',
  'triste',
  'effraye',
  'mefiant',
  'confus',
  'curieux',
  'fier',
  'timide',
  'blase',
  'somnolent',
];

/** Seconds into the state: past the longest morph, every pose is settled. */
const FROZEN_AT = 1;

const INK_COLOR = 'encre';

function Cell({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex flex-col items-center gap-1.5">
      {children}
      <span className="text-xs text-muted-foreground select-none">{label}</span>
    </div>
  );
}

export default function BloubDemo() {
  return (
    <div className="min-h-screen bg-background text-foreground p-8 flex flex-col gap-10">
      <h1 className="text-lg font-medium">Bloub catalogue</h1>

      <section className="flex flex-col gap-6">
        <h2 className="text-sm text-muted-foreground">Shapes × states</h2>
        {STATES.map((state) => (
          <div key={state} className="flex items-start gap-6">
            <span className="w-20 shrink-0 pt-10 text-xs text-muted-foreground select-none">
              {state}
            </span>
            <div className="grid grid-cols-8 gap-6 flex-1">
              {SHAPES.map((shape) => (
                <Cell
                  key={shape}
                  label={shape}
                  testId={`bloub-demo-${shape}-${state}`}
                >
                  <Bloub
                    state={state}
                    shape={shape}
                    color={INK_COLOR}
                    size={96}
                    frozenAt={FROZEN_AT}
                  />
                </Cell>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm text-muted-foreground">Expressions</h2>
        <div className="grid grid-cols-8 gap-x-6 gap-y-8">
          {EXPRESSIONS.map((expression) => (
            <Cell key={expression} label={expression} testId={`bloub-demo-expr-${expression}`}>
              <Bloub
                state="idle"
                shape="cercle"
                color={INK_COLOR}
                expression={expression}
                size={96}
                frozenAt={FROZEN_AT}
              />
            </Cell>
          ))}
        </div>
      </section>
    </div>
  );
}
