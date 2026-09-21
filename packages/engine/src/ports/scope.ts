/** Which workspace a call belongs to. Every port method takes one (Arch §7, BR-18). */
export interface Scope {
  workspaceId: string;
}

/** Local mode has exactly one implicit workspace (Arch §15.2). */
export const LOCAL_WORKSPACE_ID = 'local';

/** The scope every local-mode call uses. */
export const LOCAL_SCOPE: Scope = { workspaceId: LOCAL_WORKSPACE_ID };
