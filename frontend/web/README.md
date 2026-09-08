# pi-do web (first chat slice)

Rsbuild + React 19 + TypeScript SPA. Empty-thread state only: a centered
`PromptInput` hero, no backend wiring.

## Run

```sh
npm i
npm run dev     # local dev server
npm run build   # static SPA output in dist/
npm run preview # preview the production build
```

## What's here

- `src/theme.css` — shadcn preset `b1D0dxmC` (base-mira, neutral) tokens as
  plain CSS vars: `:root` light oklch + `.dark` / `[data-theme="dark"]`
  overrides, `body` bg/fg/font base, plus the centered layout contract
  (`.page` = min-height 100dvh grid place-items-center, `.hero` = 768px cap).
  No Tailwind, no Next.js. Font stack is Geist/Inter with system fallback
  (zero deps; optionally `npm i geist` later keeping the same var names).
- `src/components/prompt-input/` — v1 port of the local aicss
  `ai-agent-input`: `PromptInput.tsx` (frame + contentEditable field +
  placeholder + row + plus-button shell + send),
  `PromptInput.module.css` (verbatim copy incl. `:global` token blocks;
  only override is `.wrap{width:100%;max-width:100%}` so the bar fills the
  768px hero instead of the upstream 420px cap), `index.ts` barrel.
  `onSubmit?: (text: string) => void` wires to the session WS send path.
  No prompt-enhancement affordance ships (no `/enhance` route exists).
- Deferred to later slices: slash/skills palette, plus menu, model
  list/popover, attachments.

## Notes

- The worker (`worker/src/index.ts`, Hono + Valibot) is untouched; `GET /`
  health JSON still serves as before.
- Serving `dist/` as Worker static assets is a later slice; this slice only
  produces the static bundle.
- `frontend/refs` is read-only reference material and stays untouched.
