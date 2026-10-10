import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PricingTableSchema, emptyPricingTable, type PricingTable } from '@ace/contracts';

/**
 * `<dataDir>/ace.pricing.json` (D306): what Domain prices a turn with when its provider reported no
 * cost — per provider type and model, input and output per 1M tokens. It ships empty, so nothing is
 * priced until someone adds a model; a missing price is shown "—", never 0.
 *
 * It is read again whenever its modification time changes, so an edit needs no restart. A file
 * that cannot be read or does not match the shape prices nothing, and says why once per version
 * of the file — a broken price list must never stop a run.
 */

export const PRICING_FILE = 'ace.pricing.json';

export interface PricingLoader {
  current(): PricingTable;
}

export interface PricingLoaderOptions {
  dataDir: string;
  logger?: { warn(fields: Record<string, unknown>, message: string): void };
}

export function createPricingLoader(options: PricingLoaderOptions): PricingLoader {
  const path = join(options.dataDir, PRICING_FILE);
  let seen: number | undefined;
  let table = emptyPricingTable();

  // Ships empty: the file is there to be found and filled in.
  try {
    statSync(path);
  } catch {
    try {
      writeFileSync(path, `${JSON.stringify(emptyPricingTable(), null, 2)}\n`, { flag: 'wx' });
    } catch {
      // Another process wrote it first, or the folder is read-only: an absent file prices nothing.
    }
  }

  return {
    current() {
      let mtime: number;
      try {
        mtime = statSync(path).mtimeMs;
      } catch {
        seen = undefined;
        table = emptyPricingTable();
        return table;
      }
      if (mtime === seen) return table;
      seen = mtime;
      try {
        table = PricingTableSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      } catch (error) {
        table = emptyPricingTable();
        options.logger?.warn(
          {
            subsystem: 'pricing',
            path,
            err: error instanceof Error ? error.message : String(error),
          },
          'ace.pricing.json could not be read; nothing is priced from it until it is fixed',
        );
      }
      return table;
    },
  };
}
