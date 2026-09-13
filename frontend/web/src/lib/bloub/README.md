# bloub engine

Verbatim copy of the animation engine from [jeremy-prt/bloub](https://github.com/jeremy-prt/bloub)
(`refs/bloub/src/bot/*.ts`), MIT licensed — see the repo-root `LICENSE` (Copyright (c) 2026
Jérémy Perret). The upstream files carry no per-file license headers; this directory and the
copied files are covered by that MIT grant.

Files: `engine.ts` (clockless `BotEngine`, `sample(t)` is a pure function of time), `states.ts`
(state catalogue), `face.ts`, `skins.ts`, `expressions.ts`, `repere.ts` (RAYON / DEMI_VIEWBOX),
`eyefit.ts`, `cycles.ts`, `math.ts`, `decor.ts`, `profiles.ts`, `shape.ts`.

Do not edit these files; they are kept identical to upstream so engine fixes can be re-synced
with a plain copy. The React rendering layer lives in `../../components/roster/Bloub.tsx`.
