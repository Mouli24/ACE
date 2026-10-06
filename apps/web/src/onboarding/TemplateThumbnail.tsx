import type { TemplateId } from '@ace/contracts';

/**
 * A small hand-drawn picture of each template's graph (FR-ONB-002 "preview thumbnail"). The shapes
 * follow what the templates build: a chain; a writer and reviewer with a loop back; two researchers
 * fanned into a merge; and a retrieval step feeding the answerer. Decorative — the card's text says
 * the same thing — so it is hidden from screen readers.
 */

type Box = { x: number; y: number; accent?: boolean };
type Line = { from: Box; to: Box };

const W = 22;
const H = 12;

const box = (x: number, y: number, accent = false): Box => ({ x, y, accent });

const SHAPES: Readonly<Record<TemplateId, { boxes: Box[]; lines: Line[]; loop?: Line }>> = (() => {
  const chain = [box(4, 26), box(49, 26, true), box(94, 26)];
  const reviewFix = [box(2, 26), box(36, 26, true), box(70, 26, true), box(104, 26)];
  const research = { i: box(4, 26), a: box(49, 8, true), b: box(49, 44, true), m: box(94, 26) };
  const rag = { i: box(2, 26), r: box(36, 8), a: box(70, 26, true), o: box(104, 26) };
  const builder = [box(4, 26), box(49, 26, true), box(94, 26)];
  const team = [box(2, 26), box(28, 26), box(54, 26, true), box(80, 26, true), box(104, 26)];
  const pairs = (list: Box[]): Line[] =>
    list.slice(1).map((to, index) => ({ from: list[index]!, to }));
  return {
    'linear-chain': { boxes: chain, lines: pairs(chain) },
    'review-fix': {
      boxes: reviewFix,
      lines: pairs(reviewFix),
      loop: { from: reviewFix[2]!, to: reviewFix[1]! },
    },
    'parallel-research': {
      boxes: Object.values(research),
      lines: [
        { from: research.i, to: research.a },
        { from: research.i, to: research.b },
        { from: research.a, to: research.m },
        { from: research.b, to: research.m },
      ],
    },
    'single-builder': { boxes: builder, lines: pairs(builder) },
    'plan-build-review': {
      boxes: team,
      lines: pairs(team),
      loop: { from: team[3]!, to: team[2]! },
    },
    'rag-qa': {
      boxes: Object.values(rag),
      lines: [
        { from: rag.i, to: rag.r },
        { from: rag.i, to: rag.a },
        { from: rag.r, to: rag.a },
        { from: rag.a, to: rag.o },
      ],
    },
  };
})();

export function TemplateThumbnail({ id }: { id: TemplateId }) {
  const shape = SHAPES[id];
  return (
    <svg
      viewBox="0 0 128 64"
      aria-hidden="true"
      focusable="false"
      data-testid={`template-thumbnail-${id}`}
      className="h-16 w-32 shrink-0 rounded-md border border-border bg-canvas"
    >
      {shape.lines.map(({ from, to }, index) => (
        <line
          key={index}
          x1={from.x + W}
          y1={from.y + H / 2}
          x2={to.x}
          y2={to.y + H / 2}
          stroke="currentColor"
          strokeOpacity={0.5}
          strokeWidth={1.5}
        />
      ))}
      {shape.loop && (
        <path
          d={`M ${shape.loop.from.x + W / 2} ${shape.loop.from.y + H} C ${shape.loop.from.x + W / 2} ${shape.loop.from.y + H + 16}, ${shape.loop.to.x + W / 2} ${shape.loop.to.y + H + 16}, ${shape.loop.to.x + W / 2} ${shape.loop.to.y + H}`}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.5}
          strokeWidth={1.5}
          strokeDasharray="3 2"
        />
      )}
      {shape.boxes.map((b, index) => (
        <rect
          key={index}
          x={b.x}
          y={b.y}
          width={W}
          height={H}
          rx={3}
          className={b.accent ? 'fill-accent' : 'fill-card'}
          stroke="currentColor"
          strokeOpacity={0.6}
        />
      ))}
    </svg>
  );
}
