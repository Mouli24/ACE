/**
 * The only web permissions the window grants (D294): the clipboard, which the Canvas, code blocks,
 * settings and the CLI scan use through `navigator.clipboard`. Electron grants everything by default;
 * the shell denies the rest — camera, microphone, geolocation, notifications, HID, serial … — and
 * grants the clipboard only to the app's own origin.
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
]);

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Grant `permission` to a request from `requestingUrl` (a URL or an origin)? */
export function permissionAllowed(
  permission: string,
  requestingUrl: string,
  appOrigin: string | undefined,
): boolean {
  return (
    ALLOWED_PERMISSIONS.has(permission) &&
    appOrigin !== undefined &&
    originOf(requestingUrl) === appOrigin
  );
}
