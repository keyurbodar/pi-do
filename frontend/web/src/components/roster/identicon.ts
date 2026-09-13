// Deterministic identicon avatars for the new-bot dialog. A djb2 hash of the
// bot name seeds a mirrored 5x5 cell grid; three style variants change the
// cell shape and palette derivation. Rendered as inline SVG (no deps).
export function hashName(name: string): number {
  let hash = 5381;
  for (let i = 0; i < name.length; i += 1) {
    hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

const PALETTES: readonly (readonly string[])[] = [
  ["#5b8def", "#9b7ede", "#45b8c4"],
  ["#e8883a", "#e5b23a", "#e0645c"],
  ["#57b78a", "#45b8c4", "#e08bb0"],
];

function mulberry(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function identiconSvg(name: string, variant: number): string {
  const seed = (hashName(name || "bot") + variant * 0x9e3779b9) >>> 0;
  const rand = mulberry(seed);
  const palette = PALETTES[((variant % PALETTES.length) + PALETTES.length) % PALETTES.length] ?? PALETTES[0];
  const background = "#1c1c21";
  const cells: string[] = [];
  const size = 64;
  const cell = size / 5;
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      if (rand() < 0.48) continue;
      const color = palette[Math.floor(rand() * palette.length) % palette.length] ?? palette[0];
      const mirror = col === 2 ? 4 : col;
      const positions = col === mirror ? [{ x: col, y: row }] : [{ x: col, y: row }, { x: mirror, y: row }];
      for (const { x, y } of positions) {
        const px = x * cell;
        const py = row * cell;
        if (variant % 3 === 1) {
          cells.push(
            `<circle cx="${px + cell / 2}" cy="${py + cell / 2}" r="${cell / 2 - 1.5}" fill="${color}"/>`,
          );
        } else if (variant % 3 === 2) {
          cells.push(
            `<polygon points="${px + cell / 2},${py + 2} ${px + cell - 2},${py + cell - 2} ${px + 2},${py + cell - 2}" fill="${color}"/>`,
          );
        } else {
          cells.push(
            `<rect x="${px + 1.5}" y="${py + 1.5}" width="${cell - 3}" height="${cell - 3}" rx="4" fill="${color}"/>`,
          );
        }
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="14" fill="${background}"/>${cells.join("")}</svg>`;
}

export function identiconDataUrl(name: string, variant: number): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(identiconSvg(name, variant))}`;
}
