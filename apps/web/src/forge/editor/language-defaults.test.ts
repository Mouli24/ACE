import { describe, expect, it } from 'vitest';

import { asMonaco, createFakeMonaco } from '../../test/fake-monaco';
import { configureLanguageDefaults, IGNORED_TS_DIAGNOSTICS } from './language-defaults';

describe('review I3: Monaco’s language defaults for real projects', () => {
  it('compiles TS and JS as a modern React project would, keeping other options', () => {
    const fake = createFakeMonaco();
    const { typescriptDefaults, javascriptDefaults } = fake.typescript;
    typescriptDefaults.setCompilerOptions({
      ...typescriptDefaults.getCompilerOptions(),
      paths: { '@/*': ['src/*'] },
    });
    configureLanguageDefaults(asMonaco(fake));

    for (const defaults of [typescriptDefaults, javascriptDefaults]) {
      expect(defaults.getCompilerOptions()).toMatchObject({
        target: 99,
        module: 99,
        moduleResolution: 100, // Bundler: TS 5.9 has it, Monaco's enum does not name it
        jsx: 4,
        allowJs: true,
        allowNonTsExtensions: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        strict: true,
        skipLibCheck: true,
      });
    }
    expect(typescriptDefaults.getCompilerOptions()).toMatchObject({ paths: { '@/*': ['src/*'] } });
  });

  it('keeps both validations on and ignores only "this file is not loaded" errors', () => {
    const fake = createFakeMonaco();
    const { typescriptDefaults, javascriptDefaults } = fake.typescript;
    typescriptDefaults.setDiagnosticsOptions({
      ...typescriptDefaults.getDiagnosticsOptions(),
      diagnosticCodesToIgnore: [80001],
    });
    configureLanguageDefaults(asMonaco(fake));
    configureLanguageDefaults(asMonaco(fake));

    for (const defaults of [typescriptDefaults, javascriptDefaults]) {
      const options = defaults.getDiagnosticsOptions();
      expect(options).toMatchObject({ noSemanticValidation: false, noSyntaxValidation: false });
      expect(options.diagnosticCodesToIgnore).toEqual(expect.arrayContaining([2307, 2792, 7016]));
      // set once, however often the defaults are applied
      expect(options.diagnosticCodesToIgnore?.filter((code) => code === 2307)).toHaveLength(1);
    }
    expect(typescriptDefaults.getDiagnosticsOptions().diagnosticCodesToIgnore).toContain(80001);
    // a real type error is never among them
    expect(IGNORED_TS_DIAGNOSTICS).not.toContain(2322);
  });

  it('lets JSON hold comments and trailing commas, keeping every schema already registered', () => {
    const fake = createFakeMonaco();
    const { jsonDefaults } = fake.json;
    const schemas = [
      { uri: 'ace://output-contract', fileMatch: ['*'], schema: { type: 'object' } },
    ];
    jsonDefaults.setDiagnosticsOptions({ ...jsonDefaults.diagnosticsOptions, schemas });
    configureLanguageDefaults(asMonaco(fake));

    expect(jsonDefaults.diagnosticsOptions).toEqual({
      validate: true,
      allowComments: true,
      schemas,
      enableSchemaRequest: false,
      schemaRequest: 'warning',
      schemaValidation: 'warning',
      comments: 'ignore',
      trailingCommas: 'ignore',
    });
  });

  it('N1: keeps strict on but does not report implicit any, which only means "that module is not loaded"', () => {
    const fake = createFakeMonaco();
    configureLanguageDefaults(asMonaco(fake));

    for (const defaults of [
      fake.typescript.typescriptDefaults,
      fake.typescript.javascriptDefaults,
    ]) {
      expect(defaults.getCompilerOptions()).toMatchObject({ strict: true, noImplicitAny: false });
    }
  });
});
