/**
 * Inline SVG marks.
 *
 * Drawn here rather than pulled from an icon set for the same reason the app
 * ships no web fonts: it makes no outbound requests, and a dependency whose
 * only job is to draw six 17px glyphs is a dependency a reader of this
 * repository would have to audit.
 *
 * Every glyph is on a 17x17 grid and inherits `stroke: currentcolor` from the
 * rail, so the selected state needs no second copy in a different colour.
 */

export function BrandMark({ size = 26 }: { size?: number }): React.ReactElement {
  // The same three-lane figure as the favicon and the executable icon.
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect x="0" y="0" width="64" height="64" rx="14" fill="var(--line-2)" />
      <rect x="1.5" y="1.5" width="61" height="61" rx="12.5" fill="#0c0f13" />
      <rect x="11" y="18" width="28" height="8" rx="4" fill="#37c98b" />
      <rect x="19" y="29" width="34" height="8" rx="4" fill="#9d7bff" />
      <rect x="11" y="40" width="21" height="8" rx="4" fill="#ffb000" />
      <rect x="42.5" y="10" width="3" height="44" rx="1.5" fill="#eef1f5" />
    </svg>
  );
}

function Glyph({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <svg viewBox="0 0 17 17" aria-hidden="true">
      {children}
    </svg>
  );
}

/** Overview: the lanes the whole app is about. */
export function IconOverview(): React.ReactElement {
  return (
    <Glyph>
      <path d="M2.5 4.5h8M5.5 8.5h9M2.5 12.5h6" />
    </Glyph>
  );
}

/** Daily: a day's activity as columns. */
export function IconDaily(): React.ReactElement {
  return (
    <Glyph>
      <path d="M2.5 14.5h12" />
      <path d="M4.5 14.5v-4M8 14.5v-8M11.5 14.5v-6" />
    </Glyph>
  );
}

/** Cost. */
export function IconCost(): React.ReactElement {
  return (
    <Glyph>
      <circle cx="8.5" cy="8.5" r="6" />
      <path d="M8.5 4.8v7.4" />
      <path d="M10.6 6.6c-.4-.6-4-.8-4 .8s4 .6 4 2.1c0 1.6-3.5 1.4-4 .7" />
    </Glyph>
  );
}

/** Compare: two measurements side by side. */
export function IconCompare(): React.ReactElement {
  return (
    <Glyph>
      <path d="M5 13.5V6M12 13.5V3.5" />
      <path d="M2.5 13.5h12" />
      <path d="M8.5 2v13" strokeDasharray="1.5 2" opacity=".6" />
    </Glyph>
  );
}

/** Sources: where the logs live. */
export function IconSources(): React.ReactElement {
  return (
    <Glyph>
      <ellipse cx="8.5" cy="4.5" rx="5.5" ry="2.2" />
      <path d="M3 4.5v8c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2v-8" />
      <path d="M3 8.5c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" />
    </Glyph>
  );
}

/** Quit. */
export function IconPower(): React.ReactElement {
  return (
    <Glyph>
      <path d="M8.5 2.5v6" />
      <path d="M12.6 4.7a5.5 5.5 0 1 1-8.2 0" />
    </Glyph>
  );
}
