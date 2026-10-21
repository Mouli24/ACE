import { Suspense, lazy, type ComponentType } from 'react';

/** A thenable that settles at once: React.lazy then renders without suspending. */
function settled<T>(value: T): Promise<T> {
  return { then: (resolve: (result: T) => unknown) => resolve(value) } as unknown as Promise<T>;
}

export interface LazyPage {
  /** The route's element: the screen, in a quiet (empty) Suspense boundary while it loads. */
  Page: ComponentType;
  /** Fetch the screen's chunk now; the same load the route uses, so it happens once. */
  preload: () => Promise<void>;
}

/**
 * Audit U-8: a route's screen in its own chunk. `load` imports it and picks the component. The
 * first visit loads it (the shell stays up; the screen's area is empty for that moment); a chunk
 * already loaded — by a visit or by `preload` — renders at once, as a static import would. A chunk
 * that fails to load throws into the route's `errorElement`, which offers Reload.
 */
export function lazyPage(load: () => Promise<ComponentType>): LazyPage {
  let screen: ComponentType | undefined;
  let loading: Promise<void> | undefined;
  const preload = () =>
    (loading ??= load().then(
      (component) => {
        screen = component;
      },
      (error: unknown) => {
        // a chunk that failed to load is asked for again next time
        loading = undefined;
        throw error;
      },
    ));
  const Screen = lazy(() =>
    screen !== undefined
      ? settled({ default: screen })
      : preload().then(() => ({ default: screen as ComponentType })),
  );
  function Page() {
    return (
      <Suspense fallback={null}>
        <Screen />
      </Suspense>
    );
  }
  return { Page, preload };
}
