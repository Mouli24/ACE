import { describe, expect, it } from 'vitest';

import { AssistantApplyRequestSchema, AssistantProposeRequestSchema } from '../assistant.js';

const proposal = {
  summary: 'A planner, a builder and a reviewer for a booking app.',
  projectName: 'Booking app',
  team: 'plan-build-review',
  agents: [
    { role: 'planner', name: 'Planner', instructions: 'Plan it.' },
    { role: 'builder', name: 'Builder', instructions: 'Build it.' },
    { role: 'reviewer', name: 'Reviewer', instructions: 'Review it.' },
  ],
  maxCostPerRunUsd: 0.5,
  notes: [],
  source: 'rules',
};

describe('ACE parity P2 — Assistant setup', () => {
  it('takes a prompt, and a previous proposal to revise', () => {
    expect(AssistantProposeRequestSchema.safeParse({ prompt: 'Build a booking app' }).success).toBe(
      true,
    );
    expect(
      AssistantProposeRequestSchema.safeParse({ prompt: 'Add a reviewer', previous: proposal })
        .success,
    ).toBe(true);
    expect(AssistantProposeRequestSchema.safeParse({ prompt: ' ' }).success).toBe(false);
  });

  it('applies a proposal with at most three agents and a known team', () => {
    expect(AssistantApplyRequestSchema.safeParse({ proposal }).success).toBe(true);
    expect(
      AssistantApplyRequestSchema.safeParse({ proposal: { ...proposal, team: 'swarm' } }).success,
    ).toBe(false);
    expect(
      AssistantApplyRequestSchema.safeParse({
        proposal: { ...proposal, agents: [...proposal.agents, ...proposal.agents] },
      }).success,
    ).toBe(false);
  });
});
