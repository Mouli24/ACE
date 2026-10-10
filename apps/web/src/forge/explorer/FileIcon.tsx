import { File, FileCode, FileImage, FileJson, FileText, type LucideIcon } from 'lucide-react';

import { extensionOf, isImagePath } from '../files/paths';

const CODE = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'cs',
  'rb',
  'php',
  'sh',
  'css',
  'scss',
  'html',
  'vue',
  'sql',
]);
const TEXT = new Set(['md', 'txt', 'log', 'csv', 'yml', 'yaml', 'toml', 'ini', 'env']);

function iconOf(path: string): LucideIcon {
  if (isImagePath(path)) return FileImage;
  const extension = extensionOf(path);
  if (extension === 'json' || extension === 'jsonc') return FileJson;
  if (CODE.has(extension)) return FileCode;
  if (TEXT.has(extension)) return FileText;
  return File;
}

export function FileIcon({ path, className }: { path: string; className?: string }) {
  const Icon = iconOf(path);
  return <Icon className={className ?? 'h-3.5 w-3.5 shrink-0 text-fg-muted'} aria-hidden />;
}
