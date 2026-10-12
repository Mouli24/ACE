import { LogoMark, ThemeToggle } from '../theme/primitives';

/** Home's sticky 44px header (`Ace Home.dc.html`, D337): the mark, "ACE", "HOME", the ☀ / ☾ toggle. */
export function HomeHeader() {
  return (
    <header className="sticky top-0 z-10 flex h-[44px] items-center gap-[10px] bg-[var(--hdr)] px-[36px] shadow-[0_1px_0_var(--line)] backdrop-blur-[10px]">
      <LogoMark size={14} />
      <div className="text-[15px] font-bold tracking-[0.02em]">ACE</div>
      <div className="text-[9px] font-semibold tracking-[0.12em] text-[var(--muted)]">HOME</div>
      <div className="flex-1" />
      <ThemeToggle variant="home" />
    </header>
  );
}
