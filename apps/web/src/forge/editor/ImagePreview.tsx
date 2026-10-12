import { useEffect, useState } from 'react';

import { api } from '../../app/api';
import { nameOf } from '../files/paths';
import { FileNotice } from './FileNotice';

/** An image opens as a picture (§6.2), fetched with the session token and shown from a blob URL. */
export function ImagePreview({ projectId, path }: { projectId: string; path: string }) {
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setState({});
    api()
      .readFileRaw(projectId, path, controller.signal)
      .then(
        (blob) => {
          url = URL.createObjectURL(blob);
          setState({ url });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setState({ error: error instanceof Error ? error.message : String(error) });
        },
      );
    return () => {
      controller.abort();
      if (url !== undefined) URL.revokeObjectURL(url);
    };
  }, [projectId, path]);

  if (state.error !== undefined)
    return (
      <FileNotice
        path={path}
        kind="missing"
        message={`This image could not be shown: ${state.error}`}
      />
    );
  if (state.url === undefined)
    return (
      <div className="flex h-full items-center justify-center text-[13px] text-[var(--muted)]">
        Loading {nameOf(path)}…
      </div>
    );
  return (
    <div className="grid h-full place-items-center overflow-auto bg-[var(--surface)] p-[24px]">
      <img src={state.url} alt={nameOf(path)} className="max-h-full max-w-full object-contain" />
    </div>
  );
}
