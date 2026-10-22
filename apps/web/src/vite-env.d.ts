/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ACE_URL?: string;
  readonly VITE_ACE_MOCK?: string;
}

/** The Material Icon Theme's matching rules (`vite-material-icons.ts`). */
declare module 'virtual:material-icons' {
  type Names = Readonly<Record<string, string>>;
  const icons: {
    file: string;
    folder: string;
    folderExpanded: string;
    fileExtensions: Names;
    fileNames: Names;
    folderNames: Names;
    folderNamesExpanded: Names;
    languageIds: Names;
    light: Partial<
      Record<
        'fileExtensions' | 'fileNames' | 'folderNames' | 'folderNamesExpanded' | 'languageIds',
        Names
      >
    >;
    /** Icon name → its SVG's file name. */
    icons: Names;
  };
  export default icons;
}
