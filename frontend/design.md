# pi-do frontend design

Single source of truth for tokens, spacing, typography, and sourcing rules.
Patterns over one-off decisions. Everything here must survive new views.

## Goals

- Extremely fast first paint.
- Dense but calm interface.
- Minimal visual noise.
- Feels closer to a native developer tool than a marketing SaaS app.

## Avoid

- Excessive gradients.
- Glassmorphism everywhere.
- Huge rounded cards.
- Oversized typography.
- Decorative animation.
- Dashboard-style card grids.
- Unnecessary borders around every element.

## Tokens

Base ramp, the only colors in the app. Dark first.

| Step | Value | Role |
|---|---|---|
| color-1 | oklch(0.165 0.007 264) | page, inset, text on accent |
| color-2 | oklch(0.197 0.008 264) | canvas, field, stripe bg |
| color-3 | oklch(0.256 0.011 264) | surface, soft line, green tint |
| color-4 | oklch(0.303 0.013 264) | hover, line, accent tint, orange tint |
| color-5 | oklch(0.349 0.014 264) | hover-2, red tint |
| color-6 | oklch(0.396 0.016 264) | strong line, tooltip border |
| color-7 | oklch(0.459 0.018 264) | todo tag |
| color-8 | oklch(0.548 0.02 264) | tertiary ink, green, tooltip muted |
| color-9 | oklch(0.645 0.018 256) | orange, progress tag |
| color-10 | oklch(0.716 0.016 256) | secondary ink |
| color-11 | oklch(0.86 0.008 256) | accent, red, done tag, tooltip bg |
| color-12 | oklch(0.932 0.004 256) | primary ink |

Semantic mapping preserves lightness separation now that hue is gone.
Green reads color-8, orange color-9, red color-11. Diff add versus delete
differs by lightness. `.dark` mirrors `:root` exactly, so the theme toggle
is a no-op until a light ramp lands.

Shadows stay hairline rings plus the shadow-plugin stacks. Elevation rings
are achromatic by construction. Radii stay kit named. Chip 6, control 8,
card 10, window 14, pill. No numeric rounded values in new code.

Contrast tuning follows t3. One 50 to 200 scale, default 100, recomputed
through color-mix against the ramp. No second palette.

## Spacing

Base is Tailwind default, never overridden. Allowed steps are 1, 1.5, 2,
2.5, 3, 4, 6, 8 for padding and gap. Anything else needs a named token.

Layout padding lives in named inset vars, one per surface. Sidebar,
panel, composer, command. Values come from the scale, never literals.

Density is a single comfortable scale. No per-component density props.
The tunable axis is type size plus contrast, never spacing.

Markdown rhythm is tokenized. Paragraph, list, heading, and code margins
are rhythm vars, so a future compact mode is one change, not a rewrite.

## Typography

Taken fully from t3. Four surfaces, each with family plus size bounds.

Stacks use platform faces, zero webfont downloads. This is what buys the
fast first paint. The kit Inter and JetBrains Mono webfonts stay out.

- Sans: `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`
- Code: `"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace`
- Concrete names lead the code stack. Some engines alias `ui-monospace`
  to a proportional face, which breaks every code surface.

| Surface | Min | Default | Max | Behavior |
|---|---|---|---|---|
| Interface | 12 | 16 | 20 | Sets root font-size, scales every rem dimension |
| Prompt | 12 | 14 | 20 | Pinned px, composer only |
| Code | 10 | 13 | 18 | Pinned px, diffs and blocks |
| Terminal | 8 | 12 | 20 | Pinned px, exec output |

Bounds keep layouts intact instead of offering unusable extremes.
Families are customizable per surface through a sanitized preference,
max 200 chars, empty means the default stack.

Rendering rules. Tabular numerals on every count. Tight tracking on
interface type. `-webkit-font-smoothing: antialiased` on macOS with a
toggle restoring the platform default. Family availability probes by
canvas measurement, never `document.fonts.check`. Monospace candidates
verify equal advance before trust, so cell grids never break.

## Component sourcing

Library first, always. Every UI ships from an existing library.
beautiful-ui for agent primitives, base-ui for headless behavior,
aicss as cross-reference, lifted t3 pieces where they fit.

Faithful adoption on copy. Keep the primitive structure, prop-ify the
demo constants, normalize spacing to the scale, remap color to the ramp.
Never redesign a primitive while copying it.

Engineering follows t3-web, never invention. For features, frontend
wiring, streaming, fastness, and performance, adapt how t3-web does it
first. Reference lives at `frontend/refs/t3-web`. Study their
interactions and wiring, then port the mechanism onto our stack. Never
adopt a dep or pattern blindly without tracing why t3-web chose it.
Never over-engineer past what t3-web ships. If they do not do it, that
is evidence, not an invitation.

T3-web is engineering reference, not UI source. Its look stays there.
Our surfaces render our component libraries only. Reverse engineering
their UI is the wrong choice stated plainly.

Scratch implementation needs a named justification recorded here.
No library covers the need, or all candidates cost more than the build.
Absence of a quick answer is not justification.
Recorded: fence compare plus rotate in lib/pi-do-ws.ts. No library
covers domain fence comparison. A dep costs more than fifteen lines.

Nothing hardcoded. Endpoints, ports, and keys read env. Sizes, colors,
and rhythm read tokens. New surfaces reuse existing components before
adding files.

## File tree

Grows by area, never by layer dumping. New views add a route plus a
component dir. Shared code goes to lib with the domain type defined once.
Barrels stay as seams. No file past 500 lines. Split before eight files
share a directory. Read the tree live before changing it, never assume it
from this doc.
