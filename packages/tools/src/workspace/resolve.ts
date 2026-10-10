import { resolve } from 'node:path';

import { WorkspaceFsError } from '@ace/engine';

import { protectedFolderIn } from '../project/paths.js';
import { resolveInsideSandbox } from '../sandbox/paths.js';

export interface ToAbsoluteOptions {
  /** `''`, `.` and `./` name the project folder itself (a listing). */
  allowRoot?: boolean;
  /** Refuse `.git` and `.ace` at any depth (D299). */
  write?: boolean;
}

const ROOT_REFUSED = 'That names the project folder itself, not an entry in it.';

/**
 * A wire path → an absolute path inside the project, or a refusal the person can read
 * (FR-GIT-008). The sandbox's lexical and symlink rules apply, so `..`, absolute and drive paths,
 * UNC roots, `~`, NUL bytes and links out are all refused.
 */
export function toAbsolute(root: string, rel: string, options: ToAbsoluteOptions = {}): string {
  const base = resolve(root);
  // Not trimmed: "notes " is a different name from "notes", and assertValidName refuses it.
  const candidate = rel;
  if (candidate === '' || candidate === '.' || candidate === './' || candidate === '.\\') {
    if (options.allowRoot === true) return base;
    throw new WorkspaceFsError('invalid_path', ROOT_REFUSED);
  }
  const resolution = resolveInsideSandbox(base, candidate);
  if (!resolution.ok) {
    if (resolution.reason === 'sandbox_root') {
      if (options.allowRoot === true) return base;
      throw new WorkspaceFsError('invalid_path', ROOT_REFUSED);
    }
    throw new WorkspaceFsError(
      'outside_project',
      `That path is outside the project folder (${resolution.reason}).`,
      { reason: resolution.reason },
    );
  }
  if (options.write === true) {
    const folder = protectedFolderIn(base, resolution.path);
    if (folder !== undefined) {
      throw new WorkspaceFsError(
        'protected_path',
        `Forge does not change anything inside ${folder}/.`,
        {
          folder,
        },
      );
    }
  }
  return resolution.path;
}

const RESERVED_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const FORBIDDEN_CHARS = /[<>:"|?*\u0000-\u001f]/;

/**
 * A name every OS ACE runs on can hold. Windows refuses device names (`CON`, `aux.txt`), the
 * characters `<>:"|?*`, and silently drops a trailing dot or space — which would rename the file
 * under the person's feet.
 */
export function assertValidName(name: string): void {
  const reason =
    name === '' || name === '.' || name === '..'
      ? 'it is empty or a dot name'
      : FORBIDDEN_CHARS.test(name)
        ? 'it contains a character file names cannot hold'
        : /[. ]$/.test(name)
          ? 'it ends with a dot or a space'
          : RESERVED_DEVICE.test(name)
            ? 'Windows reserves that name for a device'
            : undefined;
  if (reason !== undefined) {
    throw new WorkspaceFsError('invalid_path', `"${name}" cannot be used as a name: ${reason}.`, {
      path: name,
    });
  }
}
