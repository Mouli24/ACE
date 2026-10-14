import { estimateTokens } from '../envelopes/index.js';

/**
 * D354: the estimate a debate checks its budget with before each round. A call costs its prompt
 * (characters ÷ 4, the D313 estimate) plus the output its node is expected to write: the most it
 * has written so far in this debate, or its `maxTokens` before it has spoken.
 */
export function estimateCallTokens(prompt: string, expectedOutput: number): number {
  return estimateTokens(prompt) + expectedOutput;
}

export interface ProjectedCall {
  nodeId: string;
  prompt: string;
  /** Expected output tokens. */
  output: number;
  /**
   * Input the prompt will hold that is not written yet: the judge's prompt grows by the round it
   * has not seen, about as many tokens as that round is expected to write.
   */
  extraInput?: number;
}

export interface RoundProjection {
  tokens: number;
  /** Only the calls whose model has a price; the rest cannot be projected and add nothing. */
  usd: number;
}

export function projectRound(
  calls: readonly ProjectedCall[],
  costOf?: (nodeId: string, tokensIn: number, tokensOut: number) => number | undefined,
): RoundProjection {
  let tokens = 0;
  let usd = 0;
  for (const call of calls) {
    const tokensIn = estimateTokens(call.prompt) + (call.extraInput ?? 0);
    tokens += tokensIn + call.output;
    usd += costOf?.(call.nodeId, tokensIn, call.output) ?? 0;
  }
  return { tokens, usd };
}
