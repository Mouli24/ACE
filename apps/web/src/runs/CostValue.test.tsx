import { render, screen } from '@testing-library/react';

import { templateProviderOps } from '../onboarding/template-provider';
import { createNode } from '../nodes/factory';
import {
  CostValue,
  LOCAL_COST_TEXT,
  UNKNOWN_COST_TITLE,
  costText,
  isLocalProvider,
} from './CostValue';

describe('PG-1.4 cost displays: local is free, unpriced is unknown — never $0', () => {
  it('a known cost reads as money; an unknown one says so, with the known part when there is one', () => {
    expect(costText({ costUsd: 0.5 })).toBe('$0.50');
    expect(costText({ costUsd: 0, costKnown: false })).toBe('unknown');
    expect(costText({ costUsd: 0.5, costKnown: false })).toBe('$0.50 + unknown');
  });

  it('an unknown cost carries its reason on hover; a local one reads "Free · runs on your machine"', () => {
    const { unmount } = render(<CostValue usage={{ costUsd: 0, costKnown: false }} testId="c" />);
    expect(screen.getByTestId('c')).toHaveTextContent('unknown');
    expect(screen.getByTestId('c')).toHaveAttribute('title', UNKNOWN_COST_TITLE);
    expect(screen.getByTestId('c')).toHaveAttribute('data-cost-known', 'false');
    unmount();
    render(<CostValue usage={{ costUsd: 0 }} local testId="c" />);
    expect(screen.getByTestId('c')).toHaveTextContent(LOCAL_COST_TEXT);
  });

  it('local is the contract’s providerGroup: Ollama and a LAN OpenAI-compatible server', () => {
    expect(isLocalProvider({ type: 'ollama' })).toBe(true);
    expect(isLocalProvider({ type: 'openai_compatible', baseUrl: 'http://10.0.0.5:8080/v1' })).toBe(
      true,
    );
    expect(isLocalProvider({ type: 'openai_compatible', baseUrl: 'https://api.x.ai/v1' })).toBe(
      false,
    );
    expect(isLocalProvider(undefined)).toBe(false);
  });
});

describe('PG-1.3 a template asks once for one provider for every node (D351)', () => {
  const model = (modelId: string, outputTypes: string[]) =>
    ({
      id: modelId,
      providerId: 'p1',
      modelId,
      available: true,
      inputTypes: ['text'],
      outputTypes,
    }) as never;

  it('moves every Agent/Model onto the chosen provider, on a model that fits its types', () => {
    const agent = createNode('agent', 'wf', { x: 0, y: 0 });
    const input = createNode('input', 'wf', { x: 0, y: 0 });
    const ops = templateProviderOps([agent, input], 'p1', [
      model('only-json', ['json']),
      model('texty', ['text']),
    ]);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      op: 'update_node',
      nodeId: agent.id,
      patch: { config: { providerId: 'p1', modelId: 'texty' } },
    });
  });

  it('a provider with no models leaves the model empty, so pre-flight says missing_model', () => {
    const agent = createNode('agent', 'wf', { x: 0, y: 0 });
    const [op] = templateProviderOps([agent], 'p1', []);
    expect(op).toMatchObject({ patch: { config: { providerId: 'p1', modelId: '' } } });
  });
});
