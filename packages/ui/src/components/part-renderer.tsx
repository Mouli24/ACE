import type { Part } from '@ace/contracts';
import { useState } from 'react';

import { cn } from '../lib/cn.js';
import { formatBytes } from '../lib/format.js';
import { CodeBlock } from './code-block.js';
import { JsonTree } from './json-tree.js';
import { Markdown } from './markdown.js';

/**
 * Typed output renderers (FR-MM-006/009, round 4 §5 item 3). One renderer per data type; every one
 * holds at 380 px (NFR-USE-03) and none of them fetch. `@ace/ui` imports only `@ace/contracts`, so
 * a file's bytes are never in hand here — a Part is a reference (`artifactId`), and the caller
 * passes `contentUrl` to turn that reference into a URL the browser can load or download. That keeps
 * the token and the SDK on the web side and the pixels on this side.
 *
 * Styled in the Ace UI theme (D328): media sit in radius-10 frames on the canvas colour, a file is
 * the theme's output card (an extension dot like the Forge explorer's, the name, mono meta and a
 * "Download →" chip), and the zoom toggle uses the theme's + / − glyphs.
 */

/** Turns an artifact id into a loadable/downloadable URL (the SDK's `artifactContentUrl`). */
export type ContentUrl = (artifactId: string) => string;

type MediaPart = Extract<Part, { artifactId: string }>;

/** The Forge explorer's file dot colour, by extension (the theme's `icon()`). */
function fileDotColor(name: string): string {
  const ext = name.split('.').pop() ?? '';
  const byExt: Readonly<Record<string, string>> = { ts: '#1f97a3', md: '#ef6b3f', json: '#f2c14e' };
  return byExt[ext] ?? 'var(--iconLine)';
}

const FOCUS = 'outline-none focus-visible:shadow-[0_0_0_2px_var(--focus)]';

export interface PartRendererProps {
  part: Part;
  /** Required for image/audio/video/file parts; text/json/code never call it. */
  contentUrl?: ContentUrl;
  /** The artifact's content hash, shown on the file card when the caller has it (see note). */
  hash?: string;
  className?: string;
}

/* -------------------------------------------------------------------------- */
/* Image — click to zoom                                                       */
/* -------------------------------------------------------------------------- */

export interface ImagePartViewProps {
  part: MediaPart;
  contentUrl: ContentUrl;
  className?: string;
}

export function ImagePartView({ part, contentUrl, className }: ImagePartViewProps) {
  const [zoomed, setZoomed] = useState(false);
  return (
    <figure data-testid="image-part" className={cn('m-0 flex flex-col gap-[6px]', className)}>
      <button
        type="button"
        onClick={() => setZoomed((value) => !value)}
        aria-label={zoomed ? 'Zoom out' : 'Zoom in'}
        aria-pressed={zoomed}
        className={cn(
          'group relative max-w-full cursor-pointer overflow-auto rounded-[10px] border border-[var(--line)] bg-[var(--canvas)] p-0',
          FOCUS,
        )}
      >
        <img
          src={contentUrl(part.artifactId)}
          alt={part.name}
          className={cn(
            'block h-auto rounded-[9px]',
            zoomed ? 'max-w-none cursor-zoom-out' : 'max-w-full cursor-zoom-in',
          )}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute right-[6px] top-[6px] grid h-[22px] w-[22px] place-items-center rounded-[7px] border border-[var(--line)] bg-[var(--surface)] text-[12px] leading-none text-[var(--ink)]"
        >
          {zoomed ? '−' : '+'}
        </span>
      </button>
      <figcaption className="truncate font-machine text-[10px] text-[var(--muted)]">
        {part.name}
      </figcaption>
    </figure>
  );
}

/* -------------------------------------------------------------------------- */
/* Audio / video — native players (Range-friendly plain src)                   */
/* -------------------------------------------------------------------------- */

export interface MediaPartViewProps {
  part: MediaPart;
  kind: 'audio' | 'video';
  contentUrl: ContentUrl;
  className?: string;
}

export function MediaPartView({ part, kind, contentUrl, className }: MediaPartViewProps) {
  const src = contentUrl(part.artifactId);
  return (
    <div
      data-testid={`${kind}-part`}
      className={cn('flex max-w-full flex-col gap-[6px]', className)}
    >
      {kind === 'audio' ? (
        <audio data-testid="audio-el" controls preload="metadata" src={src} className="w-full">
          <track kind="captions" />
        </audio>
      ) : (
        <video
          data-testid="video-el"
          controls
          preload="metadata"
          src={src}
          className="max-h-80 w-full rounded-[10px] border border-[var(--line)] bg-[var(--canvas)]"
        >
          <track kind="captions" />
        </video>
      )}
      <span className="truncate font-machine text-[10px] text-[var(--muted)]">{part.name}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* File — download card                                                        */
/* -------------------------------------------------------------------------- */

export interface FileDownloadCardProps {
  part: MediaPart;
  contentUrl: ContentUrl;
  /** The artifact hash, when the caller has the row; the Part itself does not carry it. */
  hash?: string;
  className?: string;
}

export function FileDownloadCard({ part, contentUrl, hash, className }: FileDownloadCardProps) {
  return (
    <a
      data-testid="file-card"
      href={contentUrl(part.artifactId)}
      download={part.name}
      className={cn(
        'group flex w-full max-w-sm items-center gap-[10px] rounded-[12px] border border-[var(--line)] bg-[var(--surface)] px-[14px] py-[11px] text-[var(--ink)] no-underline hover:border-[var(--iconLine)] hover:text-[var(--ink)]',
        FOCUS,
        className,
      )}
    >
      <span
        aria-hidden
        className="h-[8px] w-[8px] shrink-0 rounded-full"
        style={{ background: fileDotColor(part.name) }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold">{part.name}</span>
        <span className="block truncate font-machine text-[11px] text-[var(--muted)]">
          {formatBytes(part.size)} · {part.mime}
        </span>
        {hash !== undefined && (
          <span
            data-testid="file-hash"
            className="block truncate font-machine text-[10px] text-[var(--muted)]"
            title={hash}
          >
            sha256 {hash.slice(0, 12)}…
          </span>
        )}
      </span>
      <span
        aria-hidden
        className="flex h-[28px] shrink-0 items-center rounded-[8px] border border-[var(--line)] bg-[var(--chip)] px-[12px] text-[12px] font-semibold text-[var(--ink)] group-hover:bg-[var(--hover)]"
      >
        Download →
      </span>
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/* Dispatch                                                                    */
/* -------------------------------------------------------------------------- */

/** Renders one `Part` by its type. Media/file types need `contentUrl`; without it they degrade to a label. */
export function PartRenderer({ part, contentUrl, hash, className }: PartRendererProps) {
  switch (part.type) {
    case 'text':
      return <Markdown text={part.text} className={className} />;
    case 'code':
      return <CodeBlock language={part.language} text={part.text} className={className} />;
    case 'json':
      return <JsonTree value={part.value} className={className} />;
    case 'image':
      return contentUrl ? (
        <ImagePartView part={part} contentUrl={contentUrl} className={className} />
      ) : (
        <MissingUrl part={part} className={className} />
      );
    case 'audio':
      return contentUrl ? (
        <MediaPartView part={part} kind="audio" contentUrl={contentUrl} className={className} />
      ) : (
        <MissingUrl part={part} className={className} />
      );
    case 'video':
      return contentUrl ? (
        <MediaPartView part={part} kind="video" contentUrl={contentUrl} className={className} />
      ) : (
        <MissingUrl part={part} className={className} />
      );
    case 'file':
    default:
      return contentUrl ? (
        <FileDownloadCard
          part={part as MediaPart}
          contentUrl={contentUrl}
          hash={hash}
          className={className}
        />
      ) : (
        <MissingUrl part={part as MediaPart} className={className} />
      );
  }
}

/** A media/file part with no `contentUrl` to resolve it — still names the file rather than vanishing. */
function MissingUrl({ part, className }: { part: MediaPart; className?: string }) {
  return (
    <span
      data-testid="part-missing-url"
      className={cn(
        'inline-flex items-center gap-[6px] font-machine text-[10px] text-[var(--muted)]',
        className,
      )}
    >
      <span
        aria-hidden
        className="h-[7px] w-[7px] shrink-0 rounded-full"
        style={{ background: fileDotColor(part.name) }}
      />
      {part.name} ({formatBytes(part.size)})
    </span>
  );
}
