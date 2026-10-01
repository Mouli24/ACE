import { describe, expect, it } from 'vitest';

import {
  InstantiateTemplateRequestSchema,
  InstantiateTemplateResponseSchema,
  TEMPLATE_IDS,
  TemplateSchema,
} from '../templates.js';
import { KB_ID, NODE_A, NOW, PROJECT_ID, WORKFLOW_ID } from './fixtures.js';

const template = {
  id: 'rag-qa',
  name: 'RAG Q&A',
  description: 'Answer questions from your documents, with sources.',
  requires: { knowledgeBase: true },
};

const project = {
  id: PROJECT_ID,
  name: 'RAG Q&A',
  folderPath: 'C:/Users/dev/ace-projects/rag-qa',
  createdAt: NOW,
  updatedAt: NOW,
};

const workflow = {
  id: WORKFLOW_ID,
  projectId: PROJECT_ID,
  name: 'RAG Q&A',
  version: 1,
  formatVersion: 1,
  createdAt: NOW,
  updatedAt: NOW,
};

const inputNode = {
  id: NODE_A,
  workflowId: WORKFLOW_ID,
  name: 'Question',
  kind: 'input',
  position: { x: 0, y: 0 },
  inputs: [],
  outputs: [{ id: `${NODE_A}:out:text`, name: 'text', dataType: 'text', multi: true }],
  config: { artifactIds: [], outputTypes: ['text'] },
};

describe('FR-ONB-002 Template', () => {
  it('declares exactly the four templates, in the order the wizard lists them (§3)', () => {
    expect([...TEMPLATE_IDS]).toEqual([
      'linear-chain',
      'review-fix',
      'parallel-research',
      'rag-qa',
    ]);
  });

  it('parses every template id, and refuses any other', () => {
    for (const id of TEMPLATE_IDS) {
      expect(TemplateSchema.safeParse({ ...template, id }).success, id).toBe(true);
    }
    for (const id of ['rag', 'review_fix', 'blank']) {
      expect(TemplateSchema.safeParse({ ...template, id }).success, id).toBe(false);
    }
  });

  it('says whether a template needs a knowledge base', () => {
    expect(TemplateSchema.parse(template).requires).toEqual({ knowledgeBase: true });
    expect(TemplateSchema.safeParse({ ...template, requires: {} }).success).toBe(false);
  });

  it('requires a name and a one-line description', () => {
    expect(TemplateSchema.safeParse({ ...template, name: '' }).success).toBe(false);
    expect(TemplateSchema.safeParse({ ...template, description: '' }).success).toBe(false);
  });
});

describe('FR-ONB-002 instantiating a template', () => {
  it('takes a new project name, an existing project, or neither', () => {
    expect(InstantiateTemplateRequestSchema.parse({ projectName: 'My first workflow' })).toEqual({
      projectName: 'My first workflow',
    });
    expect(InstantiateTemplateRequestSchema.parse({ projectId: PROJECT_ID })).toEqual({
      projectId: PROJECT_ID,
    });
    expect(InstantiateTemplateRequestSchema.parse({})).toEqual({});
  });

  it('refuses both at once, and an empty project name', () => {
    expect(
      InstantiateTemplateRequestSchema.safeParse({ projectName: 'x', projectId: PROJECT_ID })
        .success,
    ).toBe(false);
    expect(InstantiateTemplateRequestSchema.safeParse({ projectName: '' }).success).toBe(false);
  });

  it('answers the project, the workflow and its graph, and the base rag-qa made', () => {
    const response = {
      project,
      workflow,
      nodes: [inputNode],
      edges: [],
      knowledgeBaseId: KB_ID,
    };
    expect(InstantiateTemplateResponseSchema.parse(response)).toEqual(response);

    const { knowledgeBaseId: _kb, ...withoutKb } = response;
    expect(InstantiateTemplateResponseSchema.safeParse(withoutKb).success).toBe(true);
  });
});
