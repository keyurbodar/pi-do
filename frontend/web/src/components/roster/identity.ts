// Identity vocab helpers for the roster UI. The unions live in lib/roster.ts
// (frozen contract); this file only adds display data: picker order and the
// hex swatch each BloubColor renders as.
import type { BloubColor, BloubExpression, BloubShape } from "../../lib/roster";

export const BLOUB_SHAPES: readonly BloubShape[] = [
  "cercle",
  "galet",
  "squircle",
  "capsule",
  "triangle",
  "hexagone",
  "nuage",
  "goutte",
];

export const BLOUB_COLORS: readonly BloubColor[] = [
  "encre",
  "brun",
  "rouge",
  "orange",
  "ambre",
  "vert",
  "turquoise",
  "bleu",
  "violet",
  "rose",
  "gris",
  "creme",
];

export const BLOUB_EXPRESSIONS: readonly BloubExpression[] = [
  "neutre",
  "attentif",
  "surpris",
  "excite",
  "heureux",
  "hilare",
  "colere",
  "triste",
  "effraye",
  "mefiant",
  "confus",
  "curieux",
  "fier",
  "timide",
  "blase",
  "somnolent",
];

const COLOR_HEX: Record<BloubColor, string> = {
  encre: "#26262b",
  brun: "#8b6f5c",
  rouge: "#e0645c",
  orange: "#e8883a",
  ambre: "#e5b23a",
  vert: "#57b78a",
  turquoise: "#45b8c4",
  bleu: "#5b8def",
  violet: "#9b7ede",
  rose: "#e08bb0",
  gris: "#8a8a92",
  creme: "#f2ead9",
};

export function colorHex(color: BloubColor): string {
  return COLOR_HEX[color];
}
