import { CLI_INSTALL_HINTS, CLI_LOGIN_HINTS, type CliDetectResponse } from '@ace/contracts';

/** The mock engine's terminal scan: Claude Code ready, Codex signed out, Gemini missing (X1). */
export const MOCK_CLI_SCAN: CliDetectResponse = {
  items: [
    {
      type: 'claude_code',
      installed: true,
      version: '2.1.282',
      path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
      login: 'logged_in',
      loginDetail: 'claude.ai · max',
      installHint: CLI_INSTALL_HINTS.claude_code,
      loginHint: CLI_LOGIN_HINTS.claude_code,
    },
    {
      type: 'codex_cli',
      installed: true,
      version: '0.160.1',
      path: 'C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd',
      login: 'logged_out',
      installHint: CLI_INSTALL_HINTS.codex_cli,
      loginHint: CLI_LOGIN_HINTS.codex_cli,
    },
    {
      type: 'gemini_cli',
      installed: false,
      login: 'unknown',
      installHint: CLI_INSTALL_HINTS.gemini_cli,
      loginHint: CLI_LOGIN_HINTS.gemini_cli,
    },
  ],
};
