/** The theme's code view with no file open (D334): one muted line, centred. */
export function EmptyEditor() {
  return (
    <div className="flex flex-1 items-center justify-center text-[13px] text-[var(--muted)]">
      Open a file from the explorer
    </div>
  );
}
