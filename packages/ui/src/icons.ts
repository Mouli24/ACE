/**
 * PG-1.2: the one SVG icon set controls use, in place of unicode glyphs — a glyph depends on the
 * font and shows as a box, or not at all, on some Windows setups. Re-exported so `apps/web` takes
 * every icon from `@ace/ui`, and tree-shaken: only the icons imported anywhere are bundled.
 */
export * as Icons from 'lucide-react';
export type { LucideIcon, LucideProps } from 'lucide-react';
