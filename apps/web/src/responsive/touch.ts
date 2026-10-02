/**
 * Finger-sized controls at phone width (FR-MOB-002): every button inside the element gets a 44 px
 * floor in both directions. Applied only where `useIsCompact()` is true, so desktop sizes are
 * unchanged.
 */
export const TOUCH_TARGETS = '[&_button]:min-h-11 [&_button]:min-w-11';
