import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);
const root = dirname(require.resolve('material-icon-theme/package.json'));
const ICONS = join(root, 'icons');
const VIRTUAL = 'virtual:material-icons';
const RESOLVED = `\0${VIRTUAL}`;
/** Where the SVGs are served from, under the app's base. */
const PREFIX = 'material-icons/';

type Names = Record<string, string>;
interface Manifest {
  iconDefinitions: Record<string, { iconPath: string }>;
  file: string;
  folder: string;
  folderExpanded: string;
  fileExtensions: Names;
  fileNames: Names;
  folderNames: Names;
  folderNamesExpanded: Names;
  languageIds: Names;
  light?: Partial<
    Record<
      'fileExtensions' | 'fileNames' | 'folderNames' | 'folderNamesExpanded' | 'languageIds',
      Names
    >
  >;
}

/** The theme's rules without what Forge never reads (high contrast, root folders), icons by file. */
function iconSet(): string {
  const manifest = JSON.parse(
    readFileSync(join(root, 'dist', 'material-icons.json'), 'utf8'),
  ) as Manifest;
  const icons: Names = {};
  for (const [name, { iconPath }] of Object.entries(manifest.iconDefinitions)) {
    icons[name] = iconPath.slice(iconPath.lastIndexOf('/') + 1);
  }
  return JSON.stringify({
    file: manifest.file,
    folder: manifest.folder,
    folderExpanded: manifest.folderExpanded,
    fileExtensions: manifest.fileExtensions,
    fileNames: manifest.fileNames,
    folderNames: manifest.folderNames,
    folderNamesExpanded: manifest.folderNamesExpanded,
    languageIds: manifest.languageIds,
    light: manifest.light ?? {},
    icons,
  });
}

/**
 * Material Icon Theme (PKief, MIT) — the file icons VS Code shows with `material-icon-theme` —
 * bundled so Forge works offline: `virtual:material-icons` is the theme's matching rules, and the
 * SVGs are served at `<base>material-icons/` in dev and copied there by a build.
 */
export function materialIcons(): Plugin {
  return {
    name: 'ace-material-icons',
    resolveId: (id) => (id === VIRTUAL ? RESOLVED : undefined),
    load: (id) => (id === RESOLVED ? `export default ${iconSet()};` : undefined),
    configureServer(server) {
      server.middlewares.use(`/${PREFIX}`, (req, res, next) => {
        const name = decodeURIComponent((req.url ?? '').split('?')[0]?.slice(1) ?? '');
        const file = join(ICONS, name);
        if (!/^[\w.-]+\.svg$/.test(name) || !existsSync(file)) {
          next();
          return;
        }
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const name of readdirSync(ICONS)) {
        if (!name.endsWith('.svg')) continue;
        this.emitFile({
          type: 'asset',
          fileName: `${PREFIX}${name}`,
          source: readFileSync(join(ICONS, name)),
        });
      }
    },
  };
}
