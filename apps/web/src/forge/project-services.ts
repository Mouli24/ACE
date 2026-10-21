import { useProjectTypes } from './editor/project-types';
import { useKeepFileList } from './files/hooks';
import { useProjectFiles } from './files/project-socket';

/**
 * [audit F-6] What Forge keeps for a project while one of its workflows is open, in every mode:
 * the folder's watch and the file queries it keeps fresh (`useProjectFiles`), the file list the
 * Explorer counts, and the sources Monaco knows for cross-file types (`useProjectTypes`, once the
 * editor has loaded Monaco). The workflow layout holds it, above Ideate, Forge and Domain, so a
 * switch to Forge neither walks the project again nor reloads the type sources; leaving the
 * workflow, or opening another project, lets go.
 */
export function useForgeProject(projectId: string): void {
  useProjectFiles(projectId);
  useKeepFileList(projectId);
  useProjectTypes(projectId);
}
