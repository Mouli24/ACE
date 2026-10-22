import {
  REASONING_EFFORTS,
  REVIEW_CONTRACT_SCHEMA,
  ROUTING_POLICIES,
  TRANSFORM_OPS,
  WORKSPACE_TOOL_NAMES,
  agentWorkspaceOf,
  type AgentConfig,
  type Id,
  type InputConfig,
  type MergeConfig,
  type ModelConfig,
  type Node,
  type ProviderType,
  type ReasoningEffort,
  type RetrievalConfig,
  type TransformConfig,
} from '@ace/contracts';
import { Button } from '@ace/ui';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';

import { PolicyPicker } from '../guardrails/PolicyPicker';
import { PartView } from '../inspector/EnvelopeView';
import { useWorkflowProjectId } from '../nodes/retrieval/hooks';
import { MergeModeField } from '../nodes/merge/MergeModeField';
import { MergeSlots, type MergeSlot } from '../nodes/merge/MergeSlots';
import { useProviders } from '../providers/hooks';
import { useNodeRuns } from '../runs/hooks';
import { useRunStore } from '../runs/run-store';
import { useSelectedRun } from '../runs/selected-run';
import { EFFORT, EFFORT_LABELS } from '../theme/constants';
import { useWorkflowGraph } from '../workflows/hooks';
import { AgentKnowledgeBasesField, AgentMemoryField } from './AgentKnowledgeFields';
import { AgentToolsSection } from './AgentToolsSection';
import { InputAttachments } from './InputAttachments';
import { JsonSchemaEditor } from './JsonSchemaEditor';
import { FallbackModels, ProviderAndModel, providerFor } from './ProviderAndModel';
import { RetrievalPanel } from './RetrievalPanel';
import { SkillsField, useSkills } from './SkillsField';
import { WorkspaceAccessField } from './WorkspaceAccessField';
import {
  DataTypeGroup,
  FIELD_GRID_CLASS,
  Field,
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
  UsdCapField,
} from './fields';
import { BUDGET_RANGE, EXECUTION_RANGES } from './validation';

/*
 * Each node kind's settings in the node settings modal (D333). The Agent's follow the theme's
 * modal top to bottom — provider and model, persona name, system prompt, skills — and then the
 * settings the theme has no slot for, in its field styles. The other kinds keep their own fields.
 */

/** A config patch for the node being edited; the modal completes it to the whole config (D-001). */
export type PatchConfig<C> = (patch: Partial<C>) => void;

/** D12: only fixed and fallback are offered in v1. */
const ROUTING_OPTIONS = ROUTING_POLICIES.filter((p) => p === 'fixed' || p === 'fallback').map(
  (p) => ({ value: p, label: p }),
);

/** The node's name (`update_node {name}`): trimmed, never empty, at most 80 characters. */
function NameField({
  label,
  placeholder,
  value,
  onCommit,
}: {
  label: string;
  placeholder: string;
  value: string;
  onCommit: (name: string) => void;
}) {
  return (
    <TextField
      label={label}
      value={value}
      maxLength={80}
      placeholder={placeholder}
      normalize={(draft) => draft.trim() || undefined}
      onCommit={onCommit}
    />
  );
}

/** The select's value for "no setting": Radix refuses an empty value, and `null` is no string. */
const EFFORT_DEFAULT = 'default';
const EFFORT_OPTIONS: ReadonlyArray<{
  value: ReasoningEffort | typeof EFFORT_DEFAULT;
  label: string;
}> = [
  { value: EFFORT_DEFAULT, label: EFFORT[0] },
  ...REASONING_EFFORTS.map((value) => ({ value, label: EFFORT_LABELS[value] })),
];

/**
 * D389: what the node's provider does with the level — every adapter maps it its own way, and
 * Gemini CLI has no such setting at all (the select is disabled there). No provider chosen yet:
 * a word on what it will mean.
 */
function effortHint(type: ProviderType | undefined): { hint: string; disabled?: true } {
  switch (type) {
    case 'claude_code':
      return { hint: 'Claude Code takes every level.' };
    case 'codex_cli':
      return { hint: 'Codex takes Low to Extra high; Max is sent as Extra high.' };
    case 'gemini_cli':
      return { hint: 'Gemini CLI has no reasoning-effort setting.', disabled: true };
    case 'mock':
      return { hint: 'The mock provider ignores it.' };
    case undefined:
      return { hint: 'Applied where the provider has a reasoning setting.' };
    default:
      return { hint: 'Applied by models that can reason; others ignore it.' };
  }
}

/**
 * D389: how hard the node's model thinks before it answers. Default writes `null` — no setting, the
 * provider's own default, the call exactly as before (D72: `null` is how a patch clears it).
 */
function ReasoningEffortField({
  value,
  providerId,
  onChange,
}: {
  value: ReasoningEffort | null | undefined;
  providerId: string | undefined;
  onChange: (value: ReasoningEffort | null) => void;
}) {
  const providers = useProviders();
  const { hint, disabled } = effortHint(providerFor(providers.data ?? [], providerId)?.type);
  return (
    <SelectField
      label="Reasoning effort"
      value={value ?? EFFORT_DEFAULT}
      options={EFFORT_OPTIONS}
      hint={hint}
      disabled={disabled === true}
      onChange={(picked) => onChange(picked === EFFORT_DEFAULT ? null : picked)}
    />
  );
}

function ExecutionFields({
  execution,
  providerId,
  onChange,
  children,
}: {
  execution: AgentConfig['execution'];
  /** D389: the node's provider, whose kind says what the reasoning effort does. */
  providerId: string | undefined;
  onChange: (execution: AgentConfig['execution']) => void;
  /** More numbers that sit in the same grid (the Agent's context budget). */
  children?: ReactNode;
}) {
  const set = (key: 'temperature' | 'maxTokens' | 'timeoutMs' | 'retries') => (value: number) =>
    onChange({ ...execution, [key]: value });
  return (
    <div className={FIELD_GRID_CLASS} data-testid="execution-fields">
      <NumberField
        label="Temperature"
        value={execution.temperature}
        range={EXECUTION_RANGES.temperature}
        onCommit={set('temperature')}
      />
      <NumberField
        label="Max tokens"
        value={execution.maxTokens}
        range={EXECUTION_RANGES.maxTokens}
        onCommit={set('maxTokens')}
      />
      <NumberField
        label="Timeout (ms)"
        value={execution.timeoutMs}
        range={EXECUTION_RANGES.timeoutMs}
        onCommit={set('timeoutMs')}
      />
      <NumberField
        label="Retries"
        value={execution.retries}
        range={EXECUTION_RANGES.retries}
        onCommit={set('retries')}
      />
      <UsdCapField
        label="Max cost per run of this node (USD)"
        hint="Over it, the node fails with a budget reason. Blank is no cap."
        testId="node-max-cost"
        value={execution.maxCostUsd}
        onCommit={(maxCostUsd) => onChange({ ...execution, maxCostUsd })}
      />
      <ReasoningEffortField
        value={execution.reasoningEffort}
        providerId={providerId}
        onChange={(reasoningEffort) => onChange({ ...execution, reasoningEffort })}
      />
      {children}
    </div>
  );
}

/**
 * D353 (PG-2.1): what a schema means for the node, and how its last run fared against it — passed,
 * or CONTRACT_VIOLATION with the engine's reason (BR-03 keeps that apart from RUN_FAILED).
 */
function OutputContractStatus({ nodeId }: { nodeId: Id }) {
  const last = useRunStore(
    useShallow((store) => {
      void store.revision;
      const run = store.nodeRun(nodeId);
      return {
        status: run?.status,
        failureReason: run?.failureReason,
        message: run?.error?.message,
      };
    }),
  );
  const verdict =
    last.failureReason === 'CONTRACT_VIOLATION'
      ? {
          tone: 'fail' as const,
          text: `CONTRACT_VIOLATION — ${last.message ?? 'the output did not match the schema.'}`,
        }
      : last.status === 'COMPLETED'
        ? { tone: 'pass' as const, text: 'Passed — the output matched the schema.' }
        : undefined;
  return (
    <div className="flex flex-col gap-[3px]" data-testid="output-contract-status">
      <p className="text-[12px] text-[var(--muted)]">
        Output will be JSON and checked against this schema
      </p>
      {verdict !== undefined && (
        <p
          className={
            verdict.tone === 'fail' ? 'text-[12px] text-danger' : 'text-[12px] text-[#2f7d52]'
          }
          data-testid="output-contract-verdict"
          data-verdict={verdict.tone === 'fail' ? 'CONTRACT_VIOLATION' : 'passed'}
        >
          Last run: {verdict.text}
        </p>
      )}
    </div>
  );
}

export function AgentPanel({
  node,
  config,
  patch,
  rename,
  projectId,
}: {
  node: Node;
  config: AgentConfig;
  patch: PatchConfig<AgentConfig>;
  rename: (name: string) => void;
  /** The project whose guardrail policies this node may override with (FR-GRD-002). */
  projectId?: Id;
}) {
  const skills = useSkills();
  const workspaceOn = agentWorkspaceOf(config).access !== 'off';
  const skillTools = skills.flatMap((skill) => skill.tools);
  const reviewContract = JSON.stringify(REVIEW_CONTRACT_SCHEMA);
  const usesReviewContract = JSON.stringify(config.outputContract?.jsonSchema) === reviewContract;
  return (
    <>
      <ProviderAndModel
        providerId={config.providerId}
        modelId={config.modelId}
        inputTypes={config.inputTypes}
        outputTypes={config.outputTypes}
        needs={config}
        onChange={patch}
      />
      <NameField
        label="Persona name"
        placeholder="Name this agent"
        value={node.name}
        onCommit={rename}
      />
      {/*
       * D285, D333: the node's objective, in the theme's System prompt box. It is what a run of the
       * node is asked to achieve and the standing instruction of every chat with it.
       */}
      <TextAreaField
        label="System prompt"
        value={config.instructions}
        onCommit={(instructions) => patch({ instructions })}
        rows={8}
      />
      <WorkspaceAccessField
        config={config}
        projectId={projectId}
        onChange={(workspace) => patch({ workspace })}
      />
      <SkillsField
        skills={skills}
        tools={config.tools}
        hide={workspaceOn ? ['files', 'shell'] : []}
        onChange={(tools) => patch({ tools })}
      />

      <div className="flex min-w-0 flex-col gap-5">
        <SelectField
          label="Routing policy"
          value={config.routing.policy}
          options={ROUTING_OPTIONS}
          onChange={(policy) => patch({ routing: { ...config.routing, policy } })}
        />
        <FallbackModels
          policy={config.routing.policy}
          providerId={config.providerId}
          fallbackModelIds={config.routing.fallbackModelIds}
          onChange={(fallbackModelIds) =>
            patch({ routing: { ...config.routing, fallbackModelIds } })
          }
        />
      </div>

      {/*
       * D285: no input/output type pickers — a node takes text and answers in text. A structured
       * output contract stays available for the review loop, and (D353) a schema makes the answer
       * JSON, checked against it.
       */}
      <div className="flex min-w-0 flex-col gap-[7px]" data-testid="agent-advanced-output">
        <JsonSchemaEditor
          value={config.outputContract?.jsonSchema}
          onCommit={(jsonSchema) => patch({ outputContract: jsonSchema ? { jsonSchema } : {} })}
        />
        {config.outputContract?.jsonSchema !== undefined && (
          <OutputContractStatus nodeId={node.id} />
        )}
        {/*
         * The contract a Review→Fix loop needs, in one press (§5 item 8): score, verdict and
         * issues, exactly as the contract defines them — so the loop's exit condition can read
         * `verdict` and the output is checked like any other (FR-PAR-004, FR-PAR-007).
         */}
        <Button
          variant="secondary"
          size="sm"
          className="self-start"
          data-testid="use-review-contract"
          disabled={usesReviewContract}
          onClick={() =>
            patch({
              outputContract: {
                jsonSchema: JSON.parse(reviewContract) as Record<string, unknown>,
              },
            })
          }
        >
          Use standard review contract
        </Button>
      </div>

      <ExecutionFields
        execution={config.execution}
        providerId={config.providerId}
        onChange={(execution) => patch({ execution })}
      >
        <NumberField
          label="Context budget (tokens)"
          value={config.contextPolicy.budgetTokens}
          range={BUDGET_RANGE}
          onCommit={(budgetTokens) => patch({ contextPolicy: { budgetTokens } })}
        />
      </ExecutionFields>

      <AgentToolsSection
        tools={config.tools}
        exclude={workspaceOn ? [...skillTools, ...WORKSPACE_TOOL_NAMES] : skillTools}
        hideMaxToolCalls={workspaceOn}
        onChange={(tools) => patch({ tools })}
      />
      <AgentMemoryField memory={config.memory} onChange={(memory) => patch({ memory })} />
      <PolicyPicker
        projectId={projectId}
        value={config.guardrailPolicyId}
        onChange={(guardrailPolicyId) => patch({ guardrailPolicyId })}
      />
      <AgentKnowledgeBasesField
        value={config.knowledgeBaseIds}
        projectId={projectId}
        onChange={(knowledgeBaseIds) => patch({ knowledgeBaseIds })}
      />
    </>
  );
}

export function ModelPanel({
  node,
  config,
  patch,
  rename,
}: {
  node: Node;
  config: ModelConfig;
  patch: PatchConfig<ModelConfig>;
  rename: (name: string) => void;
}) {
  return (
    <>
      <ProviderAndModel
        providerId={config.providerId}
        modelId={config.modelId}
        inputTypes={config.inputTypes}
        outputTypes={config.outputTypes}
        onChange={patch}
      />
      <NameField
        label="Persona name"
        placeholder="Name this agent"
        value={node.name}
        onCommit={rename}
      />
      <TextAreaField
        label="System prompt"
        value={config.systemPrompt ?? ''}
        onCommit={(systemPrompt) => patch({ systemPrompt })}
        rows={8}
      />
      <div className={FIELD_GRID_CLASS}>
        <DataTypeGroup
          label="Input types"
          value={config.inputTypes}
          onChange={(inputTypes) => patch({ inputTypes })}
        />
        <DataTypeGroup
          label="Output types"
          value={config.outputTypes}
          onChange={(outputTypes) => patch({ outputTypes })}
        />
      </div>
      <ExecutionFields
        execution={config.execution}
        providerId={config.providerId}
        onChange={(execution) => patch({ execution })}
      />
    </>
  );
}

export function InputPanel({
  config,
  patch,
  workflowId,
  nodeId,
}: {
  config: InputConfig;
  patch: PatchConfig<InputConfig>;
  workflowId: string;
  nodeId: Id;
}) {
  return (
    <>
      <TextAreaField
        label="Text"
        value={config.text ?? ''}
        onCommit={(text) => patch({ text })}
        rows={6}
        placeholder="Text the run starts from (or leave empty to be asked at run time, Round 2)"
      />
      <DataTypeGroup
        label="Output types"
        value={config.outputTypes}
        onChange={(outputTypes) => patch({ outputTypes })}
      />
      <InputAttachments workflowId={workflowId} nodeId={nodeId} config={config} />
    </>
  );
}

/**
 * The merge node's panel (FR-PAR-002): the mode, and one slot per connected input labelled with the
 * node feeding it. The arrival times come from the live overlay's edge transfers, which is what makes
 * "first past the post" visible in `any` mode during a run.
 */
export function MergePanel({
  node,
  config,
  patch,
  workflowId,
}: {
  node: Node;
  config: MergeConfig;
  patch: PatchConfig<MergeConfig>;
  workflowId: string;
}) {
  const graph = useWorkflowGraph(workflowId);
  const revision = useRunStore((store) => store.revision);
  const edges = graph.data?.edges ?? [];
  const nodes = graph.data?.nodes ?? [];

  const slots: MergeSlot[] = node.inputs.flatMap((port) => {
    const edge = edges.find((each) => each.to.portId === port.id);
    if (edge === undefined) return [];
    const transfer = useRunStore.getState().lastTransfer(edge.id);
    void revision;
    return [
      {
        portId: port.id,
        portName: port.name,
        fromNodeId: edge.from.nodeId,
        fromNodeName: nodes.find((each) => each.id === edge.from.nodeId)?.name ?? 'unknown node',
        ...(transfer === undefined ? {} : { arrivedAt: new Date(transfer.at).toISOString() }),
      },
    ];
  });

  return (
    <>
      <MergeModeField value={config.mode} onChange={(mode) => patch({ mode })} />
      <MergeSlots slots={slots} mode={config.mode} />
    </>
  );
}

const OP_LABEL: Record<TransformConfig['op'], string> = {
  template: 'template',
  extract_json_field: 'extract JSON field',
  join: 'join',
};

export function TransformPanel({
  config,
  patch,
}: {
  config: TransformConfig;
  patch: PatchConfig<TransformConfig>;
}) {
  return (
    <>
      <SelectField
        label="Operation"
        value={config.op}
        options={TRANSFORM_OPS.map((op) => ({ value: op, label: OP_LABEL[op] }))}
        onChange={(op) => patch({ op })}
        hint="template: json → text · extract JSON field: json → json · join: many text → text"
      />
      {config.op === 'template' && (
        <TextAreaField
          label="Template"
          value={config.template ?? ''}
          onCommit={(template) => patch({ template })}
          rows={5}
          placeholder="Hello {{name}}"
        />
      )}
      {config.op === 'extract_json_field' && (
        <TextField
          label="Path"
          value={config.path ?? ''}
          onCommit={(path) => patch({ path })}
          mono
          placeholder="result.items[0].title"
        />
      )}
      {config.op === 'join' && (
        <TextField
          label="Separator"
          value={config.separator ?? ''}
          onCommit={(separator) => patch({ separator })}
          mono
          placeholder=", "
        />
      )}
    </>
  );
}

/** The theme's empty-state line: 13px, muted, centred. */
const EMPTY_LINE_CLASS = 'py-2 text-center text-[13px] text-[var(--muted)]';

/** The theme's text link: 11.5px / 600 in the accent. */
const LINK_CLASS =
  'self-start whitespace-nowrap text-[11.5px] font-semibold text-[#e8623a] no-underline outline-none hover:text-danger focus-visible:shadow-[0_0_0_2px_var(--focus)]';

/**
 * [audit L-1] The Output node's result in the selected run (PG-3.2): what its node run recorded,
 * read as the Inspector reads it (FR-EXE-010) and drawn with the same part renderers. The empty
 * line shows only while that run has no output for this node.
 */
export function OutputPanel({ workflowId, nodeId }: { workflowId: string; nodeId: Id }) {
  const { runId } = useSelectedRun(workflowId);
  const nodeRuns = useNodeRuns(runId);
  const output = (nodeRuns.data ?? []).filter((run) => run.nodeId === nodeId).at(-1)?.output;
  return (
    <Field label="Output">
      {nodeRuns.isError ? (
        <p role="alert" className={EMPTY_LINE_CLASS}>
          Could not read this run&apos;s output.{' '}
          <Button variant="ghost" size="sm" onClick={() => void nodeRuns.refetch()}>
            Retry
          </Button>
        </p>
      ) : output === undefined || output.length === 0 ? (
        <p className={EMPTY_LINE_CLASS}>Final result appears here after a run</p>
      ) : (
        <div data-testid="output-result" className="flex flex-col gap-2">
          {output.map((part, index) => (
            <PartView key={index} part={part} />
          ))}
        </div>
      )}
      {runId !== undefined && (
        <Link to={`/runs/${runId}`} data-testid="output-see-run" className={LINK_CLASS}>
          See the whole run →
        </Link>
      )}
    </Field>
  );
}

/** Dispatch on kind so `config` narrows. The name sits where the theme puts the persona name. */
export function KindPanel({
  node,
  patch,
  rename,
  workflowId,
  projectId,
}: {
  node: Node;
  patch: (patch: Partial<Node['config']>) => void;
  /** Saves the node's name (`update_node {name}`). */
  rename: (name: string) => void;
  workflowId: string;
  /** The node's project, for the guardrail policy picker (FR-GRD-002). */
  projectId?: Id;
}) {
  // the route names the project on the Canvas; the workflow itself names it everywhere else
  const workflowProjectId = useWorkflowProjectId(workflowId);
  const project = projectId ?? workflowProjectId;
  const name = (
    <NameField label="Name" placeholder="Name this node" value={node.name} onCommit={rename} />
  );
  switch (node.kind) {
    case 'agent':
      return (
        <AgentPanel
          node={node}
          config={node.config}
          patch={patch as PatchConfig<AgentConfig>}
          rename={rename}
          {...(project === undefined ? {} : { projectId: project })}
        />
      );
    case 'model':
      return (
        <ModelPanel
          node={node}
          config={node.config}
          patch={patch as PatchConfig<ModelConfig>}
          rename={rename}
        />
      );
    case 'input':
      return (
        <>
          {name}
          <InputPanel
            config={node.config}
            patch={patch as PatchConfig<InputConfig>}
            workflowId={workflowId}
            nodeId={node.id}
          />
        </>
      );
    case 'merge':
      return (
        <>
          {name}
          <MergePanel
            node={node}
            config={node.config}
            patch={patch as PatchConfig<MergeConfig>}
            workflowId={workflowId}
          />
        </>
      );
    case 'transform':
      return (
        <>
          {name}
          <TransformPanel config={node.config} patch={patch as PatchConfig<TransformConfig>} />
        </>
      );
    case 'output':
      return (
        <>
          {name}
          <OutputPanel workflowId={workflowId} nodeId={node.id} />
        </>
      );
    case 'retrieval':
      return (
        <>
          {name}
          <RetrievalPanel
            config={node.config}
            patch={patch as PatchConfig<RetrievalConfig>}
            projectId={project}
          />
        </>
      );
    default:
      return (
        <>
          {name}
          <p className={EMPTY_LINE_CLASS}>This node kind arrives in a later round.</p>
        </>
      );
  }
}
