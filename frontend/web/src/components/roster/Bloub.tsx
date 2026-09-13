// React port of refs/bloub/src/components/BloubBot.vue (jeremy-prt/bloub, MIT).
// The engine in lib/bloub is a verbatim upstream copy; this component is its
// rendering client. The montage/cycle player and pointer-following gaze of the
// original are out of scope here: an avatar is driven by a single `state` prop.
import { useEffect, useRef, useState } from 'react';
import { NOTIF_BLUE } from '../../lib/bloub/decor';
import { BotEngine, type BotFrame } from '../../lib/bloub/engine';
import { DEMI_VIEWBOX, RAYON } from '../../lib/bloub/repere';
import type { StateId } from '../../lib/bloub/states';
import {
  DEFAULT_EXPRESSION,
  EXPRESSION_BY_ID,
} from '../../lib/bloub/expressions';
import {
  COLOR_BY_ID,
  DEFAULT_COLOR,
  DEFAULT_SHAPE,
  SHAPE_BY_ID,
  mixHex,
} from '../../lib/bloub/skins';
import type { BloubColor, BloubExpression, BloubShape } from '../../lib/roster';

/** Engine state ids (idle, thinking, alert, notify, sleep, ...). */
export type BloubState = StateId;

export interface BloubProps {
  state?: BloubState;
  shape?: BloubShape;
  color?: BloubColor;
  expression?: BloubExpression;
  size?: number;
  /** Run the rAF loop. Ignored when `frozenAt` is set. */
  playing?: boolean;
  /** Freeze the render at this time (seconds since the state began). */
  frozenAt?: number;
  className?: string;
}

// Page-background color the eye holes let through; the engine's depth mist for
// particles is mixed against it, so it must stay a concrete hex.
const PAPER = '#f9f9f9';

const VB = DEMI_VIEWBOX;

export default function Bloub({
  state = 'idle',
  shape = DEFAULT_SHAPE,
  color = DEFAULT_COLOR,
  expression = DEFAULT_EXPRESSION,
  size = 320,
  playing = true,
  frozenAt = undefined,
  className = undefined,
}: BloubProps) {
  const shapeRadii = SHAPE_BY_ID.get(shape)?.radii ?? null;
  const ink = COLOR_BY_ID.get(color)?.hex ?? '#0a0a0c';
  const expressionDef = EXPRESSION_BY_ID.get(expression) ?? null;

  // One engine per mounted component; prop changes go through its dated
  // setters so transitions morph exactly like the Vue original.
  const engineRef = useRef<BotEngine | null>(null);
  if (engineRef.current === null) {
    engineRef.current = new BotEngine(RAYON, state, shapeRadii, expressionDef);
  }
  const engine = engineRef.current;

  const clock = useRef(0);
  const [frame, setFrame] = useState<BotFrame>(() => engine.sample(frozenAt ?? 0));

  // Stable per-instance id for the mask and gradient url(#...) references.
  const uid = useRef(Math.random().toString(36).slice(2, 8)).current;
  const maskId = `bot-mask-${uid}`;

  // Redraw without the loop: frozen vignettes and prop-driven changes.
  function redrawFrozen() {
    if (frozenAt === undefined) return;
    setFrame(engine.sample(frozenAt));
  }

  useEffect(() => {
    // `setState` is a no-op when the state did not change, so this is safe to
    // re-run; the loop picks the new pose up on its next sample.
    engine.setState(state, clock.current);
    redrawFrozen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, engine]);

  useEffect(() => {
    // The engine morphs toward the new shape instead of applying it at once.
    engine.setShape(shapeRadii, clock.current);
    redrawFrozen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shapeRadii, engine]);

  useEffect(() => {
    engine.setExpression(expressionDef, clock.current);
    redrawFrozen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expressionDef, engine]);

  useEffect(() => {
    redrawFrozen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozenAt, engine]);

  useEffect(() => {
    if (frozenAt !== undefined || !playing) return;
    let raf = 0;
    let last = 0;
    const tick = (ms: number) => {
      raf = requestAnimationFrame(tick);
      // Scene clock with a bounded delta: a hidden-then-reshown tab resumes
      // without jumping ahead (rAF is suspended while it is hidden).
      const dt = last ? Math.min((ms - last) / 1000, 0.064) : 0;
      last = ms;
      clock.current += dt;
      setFrame(engine.sample(clock.current));
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, frozenAt, engine]);

  /**
   * A dot is a plain disc unless the state provides a shape (the tilted "!"
   * drop): the path is then in ball-radius units centered on the origin, so it
   * is placed with translate/rotate/scale. Color follows the body by default;
   * `depth` serves the particles, which fade into the background as they
   * recede.
   */
  function dotAttrs(dot: BotFrame['dots'][number]) {
    const fill =
      dot.color ?? (dot.depth === undefined ? ink : mixHex(PAPER, ink, dot.depth));
    const common = { fill, opacity: dot.opacity };
    return dot.d
      ? {
          ...common,
          d: dot.d,
          transform: `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`,
        }
      : { ...common, cx: dot.x, cy: dot.y, r: dot.r };
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`${-VB} ${-VB} ${VB * 2} ${VB * 2}`}
      role="img"
      aria-label="Bloub bot"
      className={className}
    >
      <defs>
        {/*
          The eyes are real holes punched through the body (like x.ai's), not
          white shapes laid on top: they are therefore automatically clipped by
          the silhouette when they slide toward the edge.
        */}
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-VB} y={-VB} width={VB * 2} height={VB * 2}>
          <path d={frame.bodyPath} fill="#fff" />
          {frame.eyes.map((eye, i) => (
            <path key={i} d={eye.d} transform={eye.matrix} opacity={eye.alpha} fill="#000" />
          ))}
          {frame.notch && (
            <circle cx={frame.notch.x} cy={frame.notch.y} r={frame.notch.r} fill="#000" />
          )}
        </mask>

        {frame.arcs.map((arc) => (
          <linearGradient
            key={arc.id}
            id={`${uid}-${arc.id}`}
            gradientUnits="userSpaceOnUse"
            x1={arc.grad.x1}
            y1={arc.grad.y1}
            x2={arc.grad.x2}
            y2={arc.grad.y2}
          >
            {arc.grad.stops.map((c, i) => (
              <stop key={i} offset={i / (arc.grad.stops.length - 1)} stopColor={c} />
            ))}
          </linearGradient>
        ))}
      </defs>

      {/* back half of the orbits: drawn before the body, so hidden by it */}
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path
            key={`b${arc.id}`}
            d={arc.back}
            stroke={`url(#${uid}-${arc.id})`}
            strokeWidth={arc.width}
            opacity={arc.opacity}
          />
        ))}
      </g>

      {/* burst particles: they pass behind the core */}
      {frame.dotsBehind && (
        <g>
          {frame.dots.map((dot, i) =>
            dot.d ? (
              <path key={`pb${i}`} {...dotAttrs(dot)} />
            ) : (
              <circle key={`pb${i}`} {...dotAttrs(dot)} />
            )
          )}
        </g>
      )}

      <g opacity={frame.bodyAlpha}>
        {/*
          Opaque underlay with the exact body shape, under the body itself.

          The eyes are HOLES punched in the body, not white shapes laid on top:
          that is what clips them at the silhouette edge, and that does not
          change. But a hole shows what is drawn behind it — and the back half
          of the rings and the burst particles are just that, so the body hides
          them. Without this underlay, a ring passing behind the ball would
          reappear INSIDE the eyes.

          Filled with `paper` and not pure white: that is exactly what the eyes
          let through until now, the page background. Making them white would
          render them lighter than the background, visible on a large ball.
        */}
        <path d={frame.bodyPath} fill={PAPER} />
        <g mask={`url(#${maskId})`}>
          <rect x={-VB} y={-VB} width={VB * 2} height={VB * 2} fill={ink} />
        </g>
      </g>

      {!frame.dotsBehind && (
        <g>
          {frame.dots.map((dot, i) =>
            dot.d ? (
              <path key={`pf${i}`} {...dotAttrs(dot)} />
            ) : (
              <circle key={`pf${i}`} {...dotAttrs(dot)} />
            )
          )}
        </g>
      )}

      {frame.notif && (
        <circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={NOTIF_BLUE} />
      )}

      {/* front half of the orbits */}
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path
            key={`f${arc.id}`}
            d={arc.front}
            stroke={`url(#${uid}-${arc.id})`}
            strokeWidth={arc.width}
            opacity={arc.opacity}
          />
        ))}
      </g>
    </svg>
  );
}
