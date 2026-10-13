import { describe, expect, it } from 'vitest';

import { parseCheckOutput, stripAnsi, toProjectPath, type CheckProblem } from './check-parser';

const WIN = 'D:\\ACE offcl\\demo';
const POSIX = '/home/me/demo';
const ESC = '\u001b';

type Row = [label: string, output: string, root: string, expected: Partial<CheckProblem>[]];

const TABLE: Row[] = [
  [
    'tsc, classic form',
    "src/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    POSIX,
    [
      {
        path: 'src/a.ts',
        line: 12,
        column: 5,
        severity: 'error',
        message: "Type 'string' is not assignable to type 'number'.",
        source: 'tsc',
        code: 'TS2322',
      },
    ],
  ],
  [
    'tsc, classic form with a chained message on the indented lines after it',
    [
      "src/a.ts(3,7): error TS2322: Type '{ a: number; }' is not assignable to type 'Foo'.",
      "  Object literal may only specify known properties, and 'a' does not exist in type 'Foo'.",
      'src/b.ts(1,1): warning TS6133: x is declared but never read.',
    ].join('\n'),
    POSIX,
    [
      {
        path: 'src/a.ts',
        line: 3,
        column: 7,
        message:
          "Type '{ a: number; }' is not assignable to type 'Foo'.\nObject literal may only specify known properties, and 'a' does not exist in type 'Foo'.",
      },
      { path: 'src/b.ts', line: 1, column: 1, severity: 'warning', code: 'TS6133' },
    ],
  ],
  [
    'tsc, pretty form with its code frame and summary, colours stripped',
    [
      `${ESC}[96msrc/a.ts${ESC}[0m:${ESC}[93m1${ESC}[0m:${ESC}[93m7${ESC}[0m - ${ESC}[91merror${ESC}[0m${ESC}[90m TS2322: ${ESC}[0mType 'string' is not assignable to type 'number'.`,
      '',
      `${ESC}[7m1${ESC}[0m const x: number = 'a';`,
      `${ESC}[7m ${ESC}[0m ${ESC}[91m      ~${ESC}[0m`,
      '',
      'src/lib/b.ts:20:3 - error TS2304: Cannot find name \u2018foo\u2019.',
      '',
      '20   foo();',
      '     ~~~',
      '',
      '',
      'Found 2 errors in 2 files.',
      '',
      'Errors  Files',
      '     1  src/a.ts:1',
      '     1  src/lib/b.ts:20',
    ].join('\n'),
    POSIX,
    [
      {
        path: 'src/a.ts',
        line: 1,
        column: 7,
        severity: 'error',
        source: 'tsc',
        code: 'TS2322',
        message: "Type 'string' is not assignable to type 'number'.",
      },
      { path: 'src/lib/b.ts', line: 20, column: 3, code: 'TS2304' },
    ],
  ],
  [
    'tsc, an absolute Windows path under the root becomes project-relative',
    `${WIN}\\src\\deep\\a.ts(4,2): error TS1005: ';' expected.`,
    WIN,
    [{ path: 'src/deep/a.ts', line: 4, column: 2, code: 'TS1005', message: "';' expected." }],
  ],
  [
    'eslint stylish: the file header, then each row with its rule',
    [
      '',
      `${POSIX}/src/a.ts`,
      "   1:10  error    'x' is assigned a value but never used  @typescript-eslint/no-unused-vars",
      '  12:3   warning  Unexpected console statement            no-console',
      '',
      `${POSIX}/lib/b.js`,
      '  0:0  error  Parsing error: Unexpected token )',
      '',
      '\u2716 3 problems (2 errors, 1 warning)',
      '  0 errors and 1 warning potentially fixable with the `--fix` option.',
    ].join('\n'),
    POSIX,
    [
      {
        path: 'src/a.ts',
        line: 1,
        column: 10,
        severity: 'error',
        message: "'x' is assigned a value but never used",
        source: 'eslint',
        code: '@typescript-eslint/no-unused-vars',
      },
      {
        path: 'src/a.ts',
        line: 12,
        column: 3,
        severity: 'warning',
        message: 'Unexpected console statement',
        code: 'no-console',
      },
      {
        path: 'lib/b.js',
        line: 1,
        column: 1,
        severity: 'error',
        message: 'Parsing error: Unexpected token )',
        source: 'eslint',
      },
    ],
  ],
  [
    'eslint stylish with colours and a Windows header',
    [
      `${ESC}[4m${WIN}\\src\\a.tsx${ESC}[24m`,
      `  ${ESC}[2m3:1${ESC}[22m  ${ESC}[31merror${ESC}[39m  Missing return type  ${ESC}[2m@typescript-eslint/explicit-function-return-type${ESC}[22m`,
    ].join('\r\n'),
    WIN,
    [
      {
        path: 'src/a.tsx',
        line: 3,
        column: 1,
        severity: 'error',
        message: 'Missing return type',
        code: '@typescript-eslint/explicit-function-return-type',
      },
    ],
  ],
  [
    'generic path:line:col: severity: message',
    [
      'src/main.c:3:5: error: expected ‘;’ before ‘}’ token',
      'src/main.c:9:1: warning: unused variable ‘y’',
      'pkg/mod.py:7:80: E501 line too long (88 > 79 characters)',
      'notes.md:2:1: note: a note',
    ].join('\n'),
    POSIX,
    [
      { path: 'src/main.c', line: 3, column: 5, severity: 'error', source: 'check' },
      {
        path: 'src/main.c',
        line: 9,
        column: 1,
        severity: 'warning',
        message: 'unused variable ‘y’',
      },
      {
        path: 'pkg/mod.py',
        line: 7,
        column: 80,
        severity: 'error',
        message: 'E501 line too long (88 > 79 characters)',
      },
      { path: 'notes.md', line: 2, column: 1, severity: 'info', message: 'a note' },
    ],
  ],
  [
    'generic path:line: message, the column read as 1',
    [
      'app/models.py:42: error: Incompatible return value type',
      './lib/x.rb:3: warning: shadowing',
    ].join('\n'),
    POSIX,
    [
      {
        path: 'app/models.py',
        line: 42,
        column: 1,
        severity: 'error',
        message: 'Incompatible return value type',
      },
      { path: 'lib/x.rb', line: 3, column: 1, severity: 'warning', message: 'shadowing' },
    ],
  ],
  [
    'absolute paths outside the root, and relative ones above it, are kept as given',
    ['/usr/include/stdio.h:12:1: error: boom', '../shared/a.ts(1,1): error TS2307: x'].join('\n'),
    POSIX,
    [
      { path: '/usr/include/stdio.h', line: 12 },
      { path: '../shared/a.ts', line: 1 },
    ],
  ],
  [
    'noise is not a problem: URLs, stack frames, prose and summaries',
    [
      '> demo@1.0.0 check /home/me/demo',
      '> tsc --noEmit',
      'Listening on http://localhost:3000',
      'Error: boom',
      '    at main (/home/me/demo/src/a.ts:3:9)',
      'Done in 1.2s.',
      'Found 0 errors.',
    ].join('\n'),
    POSIX,
    [],
  ],
];

describe('D299 Phase 4 parseCheckOutput', () => {
  it.each(TABLE)('%s', (_label, output, root, expected) => {
    const problems = parseCheckOutput(output, root);
    expect(problems).toHaveLength(expected.length);
    expected.forEach((want, index) => expect(problems[index]).toMatchObject(want));
  });

  it('reads the same diagnostic once, even when the output repeats it', () => {
    const line = 'src/a.ts(1,1): error TS1: x';
    expect(parseCheckOutput(`${line}\n${line}`, POSIX)).toHaveLength(1);
  });

  it('keeps only the last state of a line a progress bar rewrote with a carriage return', () => {
    const output = 'checking 1/3\rchecking 2/3\rsrc/a.ts(2,3): error TS9: late';
    expect(parseCheckOutput(output, POSIX)).toMatchObject([{ path: 'src/a.ts', line: 2 }]);
  });
});

describe('D299 Phase 4 stripAnsi and toProjectPath', () => {
  it('strips colour, cursor and hyperlink sequences', () => {
    expect(stripAnsi(`${ESC}[1m${ESC}[31mred${ESC}[39m${ESC}[22m ${ESC}[2K${ESC}[1Gdone`)).toBe(
      'red done',
    );
    expect(stripAnsi(`${ESC}]8;;file:///a.ts${ESC}\\a.ts${ESC}]8;;${ESC}\\`)).toBe('a.ts');
    expect(stripAnsi(`${ESC}]8;;https://x\u0007link${ESC}]8;;\u0007`)).toBe('link');
  });

  it('makes paths under the root project-relative with forward slashes', () => {
    expect(toProjectPath(`${POSIX}/src/a.ts`, POSIX)).toBe('src/a.ts');
    expect(toProjectPath(`${POSIX}/src/a.ts`, `${POSIX}/`)).toBe('src/a.ts');
    expect(toProjectPath('d:\\ace offcl\\demo\\src\\a.ts', WIN)).toBe('src/a.ts');
    expect(toProjectPath('D:/ACE offcl/demo/src/a.ts', WIN)).toBe('src/a.ts');
    expect(toProjectPath('.\\src\\a.ts', WIN)).toBe('src/a.ts');
    expect(toProjectPath('./src/a.ts', POSIX)).toBe('src/a.ts');
    expect(toProjectPath('src/a.ts', POSIX)).toBe('src/a.ts');
    // a different folder that only starts with the root's name is not under it
    expect(toProjectPath(`${POSIX}-other/a.ts`, POSIX)).toBe(`${POSIX}-other/a.ts`);
    expect(toProjectPath('E:\\elsewhere\\a.ts', WIN)).toBe('E:/elsewhere/a.ts');
  });
});
