import type { Part } from '@ace/contracts';
import { Download, File as FileIcon, ZoomIn, ZoomOut } from 'lucide-react';
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
 */

/** Turns an artifact id into a loadable/downloadable URL (the SDK's `artifactContentUrl`). */
export type ContentUrl = (artifactId: string) => string;

type MediaPart = Extract<Part, { artifactId: string }>;

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
    <figure data-testid="image-part" className={cn('flex flex-col gap-1', className)}>
      <button
        type="button"
        onClick={() => setZoomed((value) => !value)}
        aria-label={zoomed ? 'Zoom out' : 'Zoom in'}
        aria-pressed={zoomed}
        className="group relative max-w-full overflow-auto rounded border border-border bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <img
          src={contentUrl(part.artifactId)}
          alt={part.name}
          className={cn(
            'block h-auto rounded',
            zoomed ? 'max-w-none cursor-zoom-out' : 'max-w-full cursor-zoom-in',
          )}
        />
        <span className="pointer-events-none absolute right-1 top-1 rounded bg-canvas/80 p-1 text-fg-muted">
          {zoomed ? <ZoomOut className="h-3 w-3" aria-hidden /> : <ZoomIn className="h-3 w-3" aria-hidden />}
        </span>
      </button>
      <figcaption className="truncate font-machine text-[10px] text-fg-muted">{part.name}</figcaption>
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
    <div data-testid={`${kind}-part`} className={cn('flex max-w-full flex-col gap-1', className)}>
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
          className="max-h-80 w-full rounded border border-border bg-black"
        >
          <track kind="captions" />
        </video>
      )}
      <span className="truncate font-machine text-[10px] text-fg-muted">{part.name}</span>
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
        'flex w-full max-w-sm items-center gap-3 rounded-card border border-border bg-card p-3 no-underline hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        className,
      )}
    >
      <FileIcon className="h-6 w-6 shrink-0 text-fg-muted" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-human text-sm text-fg">{part.name}</span>
        <span className="block truncate font-machine text-[10px] text-fg-muted">
          {formatBytes(part.size)} · {part.mime}
        </span>
        {hash !== undefined && (
          <span
            data-testid="file-hash"
            className="block truncate font-machine text-[10px] text-fg-muted"
            title={hash}
          >
            sha256 {hash.slice(0, 12)}…
          </span>
        )}
      </span>
      <Download className="h-4 w-4 shrink-0 text-fg-muted" aria-hidden />
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
        <FileDownloadCard part={part as MediaPart} contentUrl={contentUrl} hash={hash} className={className} />
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
      className={cn('inline-flex items-center gap-1 font-machine text-[10px] text-fg-muted', className)}
    >
      <FileIcon className="h-3 w-3" aria-hidden />
      {part.name} ({formatBytes(part.size)})
    </span>
  );
}
