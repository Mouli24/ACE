import { useEffect } from 'react';

import { hasUnsavedWork, useEditorStore } from './editor-store';

/**
 * Unsaved buffers survive every in-app navigation — the editor store outlives routes — so the
 * only way to lose one is closing or reloading the browser tab: that asks first (§2.3).
 */
export function useBeforeUnloadGuard(): void {
  const unsaved = useEditorStore(hasUnsavedWork);
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);
}
