/** A one-pixel rule that lights up while dragged (react-resizable-panels sets the data attribute). */
const HANDLE =
  'shrink-0 bg-border transition-colors hover:bg-fg-faint data-[resize-handle-state=drag]:bg-accent';
export const RESIZE_HANDLE_X = `w-px ${HANDLE}`;
export const RESIZE_HANDLE_Y = `h-px ${HANDLE}`;
