import { createAceClient, type AceClient } from '@ace/sdk';

import { engineOrigin } from './env';

let client: AceClient | undefined;

export interface ConfigureApiOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

/** Build the one REST client the app uses; called once at boot (and by tests). */
export function configureApi(options: ConfigureApiOptions): AceClient {
  client = createAceClient({
    baseUrl: options.baseUrl ?? engineOrigin(),
    token: options.token,
    // resolved per call so a mock worker installed later still intercepts
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
  });
  return client;
}

export function api(): AceClient {
  if (!client) throw new Error('configureApi() has not been called');
  return client;
}
