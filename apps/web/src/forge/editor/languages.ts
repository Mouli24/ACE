import { extensionOf, nameOf } from '../files/paths';

const BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'html',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  sh: 'shell',
  bash: 'shell',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  svg: 'xml',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
};
const BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  '.env': 'ini',
  makefile: 'plaintext',
};

/** The Monaco language for a path; highlighting for every one, IntelliSense for TS/JS/CSS/HTML/JSON (§6.2). */
export function languageOf(path: string): string {
  return BY_NAME[nameOf(path).toLowerCase()] ?? BY_EXTENSION[extensionOf(path)] ?? 'plaintext';
}

const LABELS: Readonly<Record<string, string>> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  json: 'JSON',
  css: 'CSS',
  scss: 'SCSS',
  html: 'HTML',
  markdown: 'Markdown',
  python: 'Python',
  plaintext: 'Plain Text',
  yaml: 'YAML',
  shell: 'Shell',
  csharp: 'C#',
  cpp: 'C++',
};

export const languageLabel = (id: string): string =>
  LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
