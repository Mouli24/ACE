import { stat } from 'node:fs/promises';

/** Whether `path` exists and is a folder. Never throws. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
