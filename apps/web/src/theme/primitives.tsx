import { cn } from '@ace/ui';
import type { CSSProperties, ReactNode } from 'react';

import type { ProviderTheme } from './constants';
import { useThemeMode } from './mode';

/*
 * The Ace UI theme's small building blocks (D328), shared by the header, Home, the canvas, the
 * node settings modal, chat and Domain. Every size and colour is the theme's.
 */

/** The ACE mark: an orange drop, `border-radius: 50% 50% 50% 0` turned -45°. */
export function LogoMark({ size = 13 }: { size?: 13 | 14 }) {
  return (
    <div
      aria-hidden
      className="shrink-0 rotate-[-45deg] rounded-[50%_50%_50%_0] bg-[#ef6b3f]"
      style={{ width: size, height: size }}
    />
  );
}

/**
 * The ☀ / ☾ pill. `workspace` is the canvas file's (20px circles, gap 3), `home` the Home file's
 * (22px circles, gap 4). The active circle is orange with white ink.
 */
export function ThemeToggle({ variant = 'workspace' }: { variant?: 'workspace' | 'home' }) {
  const { dark, toggle } = useThemeMode();
  const home = variant === 'home';
  const circle = home ? 'h-[22px] w-[22px]' : 'h-5 w-5';
  return (
    <button
      type="button"
      onClick={toggle}
      title="Switch theme"
      aria-label="Switch theme"
      aria-pressed={dark}
      data-testid="theme-toggle"
      className={cn(
        'flex h-7 cursor-pointer items-center rounded-full border border-[var(--line)] bg-[var(--soft)] p-[3px]',
        home ? 'gap-1' : 'gap-[3px]',
      )}
    >
      <span
        aria-hidden
        className={cn(
          circle,
          'flex items-center justify-center rounded-full',
          home ? 'text-[12px]' : 'text-[11px]',
          dark ? 'bg-transparent text-[var(--muted)]' : 'bg-[#ef6b3f] text-[#fff]',
        )}
      >
        ☀
      </span>
      <span
        aria-hidden
        className={cn(
          circle,
          'flex items-center justify-center rounded-full',
          home ? 'text-[11px]' : 'text-[10px]',
          dark ? 'bg-[#ef6b3f] text-[#fff]' : 'bg-transparent text-[var(--muted)]',
        )}
      >
        ☾
      </span>
    </button>
  );
}

/**
 * A provider orb: the provider's gradient, its logo (white on coloured orbs, as drawn on the white
 * Custom orb), and the ring shadow — `ring` on the canvas, `iconRing` in lists and the modal.
 */
export function ProviderOrb({
  look,
  size,
  logo,
  shadow = 'iconRing',
  className,
  style,
  children,
}: {
  look: ProviderTheme;
  size: number;
  logo: number;
  shadow?: 'ring' | 'iconRing';
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center rounded-full', className)}
      style={{
        width: size,
        height: size,
        background: look.orb,
        boxShadow: shadow === 'ring' ? look.ring : look.iconRing,
        ...style,
      }}
    >
      <img
        src={look.logo}
        alt=""
        draggable={false}
        style={{ width: logo, height: logo, filter: look.logoFilter }}
      />
      {children}
    </span>
  );
}

/** A coloured circle with a white initial (agent avatars, filter pills, mention chips). */
export function Avatar({
  letter,
  color,
  size,
  fontSize,
  className,
  style,
}: {
  letter: string;
  color: string;
  size: number;
  fontSize: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full font-bold text-[#fff]',
        className,
      )}
      style={{ width: size, height: size, background: color, fontSize, ...style }}
    >
      {letter}
    </span>
  );
}

/**
 * The theme's 30×18 switch track: orange when on, `--iconLine` when off, a 14px white knob. Visual
 * only — the row button around it carries `role="switch"` and `aria-checked`.
 */
export function Toggle({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex h-[18px] w-[30px] shrink-0 rounded-full p-[2px]',
        on ? 'justify-end bg-[#ef6b3f]' : 'justify-start bg-[var(--iconLine)]',
      )}
    >
      <span className="h-[14px] w-[14px] rounded-full bg-[#fff] shadow-[0_1px_2px_rgba(0,0,0,0.25)]" />
    </span>
  );
}

/** A small round status dot. */
export function Dot({ color, size = 6, pulse }: { color: string; size?: number; pulse?: string }) {
  return (
    <span
      aria-hidden
      className="shrink-0 rounded-full"
      style={{ width: size, height: size, background: color, animation: pulse }}
    />
  );
}
