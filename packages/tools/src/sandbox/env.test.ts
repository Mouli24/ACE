import { describe, expect, it } from 'vitest';

import { ToolError } from '../errors.js';
import {
  SANDBOX_DEAD_PROXY,
  SANDBOX_ENV_ALLOWLIST,
  SANDBOX_MARKER_ENV,
  SCRUB_DROP,
  SCRUB_KEEP,
  SECRET_SHAPED,
  sandboxEnv,
  scrubSecrets,
} from './env.js';

const SANDBOX = '/projects/demo/.ace/sandbox/01J9ZS0ABCDEFGHJKMNPQRSTVW';

/** Every value whose name is some spelling of PATH — Windows reads them case-insensitively. */
function pathValues(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([name]) => name.toLowerCase() === 'path')
    .map(([, value]) => value);
}

describe('FR-TOOL-004 sandbox environment — nothing crosses unless allow-listed', () => {
  it('drops every inherited name that is not on the allow-list, secrets included', () => {
    const env = sandboxEnv({
      sandboxDir: SANDBOX,
      source: {
        PATH: '/usr/bin',
        LANG: 'en_GB.UTF-8',
        ANTHROPIC_API_KEY: 'not-a-real-key',
        AWS_SECRET_ACCESS_KEY: 'not-a-real-secret',
        ACE_SESSION_TOKEN: 'not-a-real-token',
        SOME_RANDOM_VAR: 'x',
      },
      platform: 'linux',
    });

    expect(env.PATH).toBe('/usr/bin');
    expect(env.LANG).toBe('en_GB.UTF-8');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('ACE_SESSION_TOKEN');
    expect(env).not.toHaveProperty('SOME_RANDOM_VAR');
  });

  it('allow-lists nothing that looks like a secret', () => {
    for (const name of SANDBOX_ENV_ALLOWLIST) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|SESSION|AUTH|COOKIE/i);
    }
  });

  it('skips an allow-listed name whose value is empty', () => {
    const env = sandboxEnv({ sandboxDir: SANDBOX, source: { LANG: '' }, platform: 'linux' });
    expect(env).not.toHaveProperty('LANG');
  });

  it('never carries NODE_OPTIONS, inherited or extra, so nothing can lift the memory cap', () => {
    const env = sandboxEnv({
      sandboxDir: SANDBOX,
      source: { NODE_OPTIONS: '--max-old-space-size=99999' },
      extra: { NODE_OPTIONS: '--max-old-space-size=99999' },
      platform: 'linux',
    });
    expect(env).not.toHaveProperty('NODE_OPTIONS');
    expect(env.NODE_PATH).toBe('');
  });

  it('applies extra variables, except secret-shaped ones', () => {
    const env = sandboxEnv({
      sandboxDir: SANDBOX,
      source: {},
      extra: { MY_SETTING: 'on', MY_API_KEY: 'nope', GITHUB_TOKEN: 'nope' },
      platform: 'linux',
    });
    expect(env.MY_SETTING).toBe('on');
    expect(env).not.toHaveProperty('MY_API_KEY');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('refuses to build an environment without a sandbox folder', () => {
    expect(() => sandboxEnv({ sandboxDir: '', source: {} })).toThrow(ToolError);
    expect(() => sandboxEnv({ sandboxDir: '   ', source: {} })).toThrow(ToolError);
  });

  it('marks the child as sandboxed', () => {
    expect(sandboxEnv({ sandboxDir: SANDBOX, source: {} })[SANDBOX_MARKER_ENV]).toBe('1');
  });
});

describe('TC-TOOL-005 home is the sandbox', () => {
  it('points every home and temp variable at the sandbox folder', () => {
    const env = sandboxEnv({
      sandboxDir: SANDBOX,
      source: { HOME: '/home/me', USERPROFILE: 'C:\\Users\\me', TMPDIR: '/tmp' },
    });

    for (const name of ['HOME', 'USERPROFILE', 'HOMEPATH', 'TMPDIR', 'TEMP', 'TMP', 'PWD']) {
      expect(env[name], name).toBe(SANDBOX);
    }
    expect(env.HOMEDRIVE).toBe('');
  });
});

describe('NFR-SEC-04 no network, said in every dialect', () => {
  it('points every proxy variable at a closed port and empties NO_PROXY', () => {
    const env = sandboxEnv({ sandboxDir: SANDBOX, source: { NO_PROXY: '*' } });

    for (const name of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'ALL_PROXY']) {
      expect(env[name], name).toBe(SANDBOX_DEAD_PROXY);
    }
    expect(env.NO_PROXY).toBe('');
    expect(env.no_proxy).toBe('');
  });

  it('pins the package installers offline', () => {
    const env = sandboxEnv({ sandboxDir: SANDBOX, source: {} });
    expect(env.PIP_NO_INDEX).toBe('1');
    expect(env.npm_config_offline).toBe('true');
    expect(env.npm_config_registry).toBe(SANDBOX_DEAD_PROXY);
    expect(env.GIT_ALLOW_PROTOCOL).toBe('none');
  });
});

describe('NFR-SEC-04 the deny shims come first on PATH', () => {
  const SHIMS = `${SANDBOX}/.ace-deny`;

  it('prepends the shim folder with `:` on POSIX', () => {
    const env = sandboxEnv({
      sandboxDir: SANDBOX,
      denyShimDir: SHIMS,
      source: { PATH: '/usr/local/bin:/usr/bin' },
      platform: 'linux',
    });
    expect(pathValues(env)).toEqual([`${SHIMS}:/usr/local/bin:/usr/bin`]);
  });

  it('prepends the shim folder with `;` on Windows, where the variable is spelled Path', () => {
    const env = sandboxEnv({
      sandboxDir: SANDBOX,
      denyShimDir: 'C:\\sandbox\\.ace-deny',
      source: { Path: 'C:\\Windows\\system32;C:\\Python312' },
      platform: 'win32',
    });

    // Windows resolves PATH case-insensitively and Node keeps the first spelling in sort order,
    // so a second spelling holding only the shim folder would hide the interpreter entirely.
    const values = pathValues(env);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(value).toBe('C:\\sandbox\\.ace-deny;C:\\Windows\\system32;C:\\Python312');
    }
  });

  it('still installs the shims when the engine had no PATH at all', () => {
    const env = sandboxEnv({
      sandboxDir: SANDBOX,
      denyShimDir: SHIMS,
      source: {},
      platform: 'linux',
    });
    expect(pathValues(env)).toEqual([SHIMS]);
  });

  it('leaves PATH alone when there is no shim folder', () => {
    const env = sandboxEnv({
      sandboxDir: SANDBOX,
      source: { PATH: '/usr/bin' },
      platform: 'linux',
    });
    expect(pathValues(env)).toEqual(['/usr/bin']);
  });
});

describe('D301 scrubSecrets — a terminal process gets the engine’s environment minus its secrets', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/ada',
    LANG: 'en_GB.UTF-8',
    ANTHROPIC_API_KEY: 'not-a-real-key',
    AWS_SECRET_ACCESS_KEY: 'not-a-real-secret',
    ACE_SESSION_TOKEN: 'not-a-real-token',
    GITHUB_TOKEN: 'not-a-real-token',
    DB_PASSWORD: 'not-a-real-password',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    SSH_AGENT_PID: '42',
    XAUTHORITY: '/home/ada/.Xauthority',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    SESSIONNAME: 'Console',
    ELECTRON_RUN_AS_NODE: '1',
    UNSET: undefined,
  };

  it('keeps what does not look like a secret, and the five sockets and paths that only look like one', () => {
    expect(scrubSecrets(source, 'linux')).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/ada',
      LANG: 'en_GB.UTF-8',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      SSH_AGENT_PID: '42',
      XAUTHORITY: '/home/ada/.Xauthority',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      SESSIONNAME: 'Console',
      FORCE_COLOR: '1',
      PYTHONUTF8: '1',
    });
  });

  it('always drops ELECTRON_RUN_AS_NODE, which is no secret but turns any Electron app into Node', () => {
    expect([...SCRUB_DROP]).toEqual(['ELECTRON_RUN_AS_NODE']);
    expect(scrubSecrets({ ELECTRON_RUN_AS_NODE: '1' }, 'linux')).not.toHaveProperty(
      'ELECTRON_RUN_AS_NODE',
    );
    expect(scrubSecrets({ Electron_Run_As_Node: '1' }, 'win32')).not.toHaveProperty(
      'Electron_Run_As_Node',
    );
  });

  it('asks Python for UTF-8 output, so the terminal does not get the console code page', () => {
    expect(scrubSecrets({ PYTHONUTF8: '0' }, 'win32').PYTHONUTF8).toBe('1');
  });

  it('needs the exception list: each kept socket name but one matches the secret rule', () => {
    expect(SECRET_SHAPED.source).toBe(
      'KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|SESSION|AUTH|COOKIE',
    );
    expect([...SCRUB_KEEP]).toEqual([
      'SSH_AUTH_SOCK',
      'SSH_AGENT_PID',
      'XAUTHORITY',
      'DBUS_SESSION_BUS_ADDRESS',
      'SESSIONNAME',
    ]);
    expect(SCRUB_KEEP.filter((name) => SECRET_SHAPED.test(name))).toEqual([
      'SSH_AUTH_SOCK',
      'XAUTHORITY',
      'DBUS_SESSION_BUS_ADDRESS',
      'SESSIONNAME',
    ]);
  });

  it('matches the kept names case-insensitively on Windows only', () => {
    expect(scrubSecrets({ SessionName: 'Console' }, 'win32')).toEqual({
      SessionName: 'Console',
      FORCE_COLOR: '1',
      PYTHONUTF8: '1',
    });
    expect(scrubSecrets({ SessionName: 'Console' }, 'linux')).toEqual({
      FORCE_COLOR: '1',
      PYTHONUTF8: '1',
    });
  });

  it('sets FORCE_COLOR=1 even over an inherited 0', () => {
    expect(scrubSecrets({ FORCE_COLOR: '0' }, 'linux').FORCE_COLOR).toBe('1');
  });
});
