/**
 * The application mark, defined once.
 *
 * Three staggered lanes crossed by a playhead: the same picture the Daily
 * screen draws, shrunk to 16 pixels. Everything is a rounded rectangle, which
 * is what lets the SVG favicon and the rasterised Windows icon be generated
 * from this one description instead of drifting apart.
 *
 * Coordinates are on a 64x64 grid.
 */

export const SIZE = 64;

export const PALETTE = {
  ink: '#0c0f13',
  edge: '#2d3642',
  codex: '#37c98b',
  claude: '#9d7bff',
  signal: '#ffb000',
  playhead: '#eef1f5',
};

/** `{ x, y, w, h, r, fill }`, painted in order. */
export const SHAPES = [
  { x: 0, y: 0, w: 64, h: 64, r: 14, fill: PALETTE.edge },
  { x: 1.5, y: 1.5, w: 61, h: 61, r: 12.5, fill: PALETTE.ink },
  { x: 11, y: 18, w: 28, h: 8, r: 4, fill: PALETTE.codex },
  { x: 19, y: 29, w: 34, h: 8, r: 4, fill: PALETTE.claude },
  { x: 11, y: 40, w: 21, h: 8, r: 4, fill: PALETTE.signal },
  { x: 42.5, y: 10, w: 3, h: 44, r: 1.5, fill: PALETTE.playhead },
];

export function toSvg() {
  const rects = SHAPES.map(
    (s) =>
      `  <rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="${s.r}" fill="${s.fill}"/>`,
  ).join('\n');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="Agent Session Observer">`,
    rects,
    '</svg>',
    '',
  ].join('\n');
}
