import {
  REVIEW_CONTRACT_SCHEMA,
  ROUTING_POLICIES,
  TRANSFORM_OPS,
  type AgentConfig,
  type Id,
  type InputConfig,
  type MergeConfig,
  type ModelConfig,
  type Node,
  type RetrievalConfig,
  type TransformConfig,
} from '@ace/contracts';
import { Button } from '@ace/ui';

import { PolicyPicker } from '../guardrails/PolicyPicker';
import { useWorkflowProjectId } from '../nodes/retrieval/hooks';
import { AgentKnowledgeBasesField, AgentMemoryField } from './AgentKnowledgeFields';
import { AgentToolsSection } from './AgentToolsSection';
import { RetrievalPanel } from './RetrievalPanel';
import { InputAttachments } from './InputAttachments';
import { MergeModeField } from '../nodes/merge/MergeModeField';
import { MergeSlots, type MergeSlot } from '../nodes/merge/MergeSlots';
import { useRunStore } from '../runs/run-store';
import { useWorkflowGraph } from '../workflows/hooks';
import { JsonSchemaEditor } from './JsonSchemaEditor';
import { FallbackModels, ProviderAndModel } from './ProviderAndModel';
import {
  DataTypeGroup,
  Field,
  LaterField,
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
} from './fields';
import { BUDGET_RANGE, EXECUTION_RANGES } from './validation';

/** A config patch for the node being edited; ConfigPanel completes it to the whole config (D-001). */
export type PatchConfig<C> = (patch: Partial<C>) => void;

/** D12: only fixed and fallback are offered in v1. */
const ROUTING_OPTIONS = ROUTING_POLICIES.filter((p) => p === 'fixed' || p === 'fallback').map(
  (p) => ({ value: p, label: p }),
);

function ExecutionFields({
  execution,
  onChange,
}: {
  execution: AgentConfig['execution'];
  onChange: (execution: AgentConfig['execution']) => void;
}) {
  const set = (key: keyof AgentConfig['execution']) => (value: number) =>
    onChange({ ...execution, [key]: value });
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 font-machine text-[10px] uppercase tracking-wider text-fg-muted">
        Execution
      </legend>
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
    </fieldset>
  );
}

export function AgentPanel({
  config,
  patch,
  projectId,
}: {
  config: AgentConfig;
  patch: PatchConfig<AgentConfig>;
  /** The project whose guardrail policies this node may override with (FR-GRD-002). */
  projectId?: Id;
}) {
  const reviewContract = JSON.stringify(REVIEW_CONTRACT_SCHEMA);
  const usesReviewContract = JSON.stringify(config.outputContract?.jsonSchema) === reviewContract;
  return (
    <>
      <ProviderAndModel
        providerId={config.providerId}
        modelId={config.modelId}
        inputTypes={config.inputTypes}
        outputTypes={config.outputTypes}
        onChange={patch}
      />
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
        onChange={(fallbackModelIds) => patch({ routing: { ...config.routing, fallbackModelIds } })}
      />
      <TextAreaField
        label="Instructions"
        value={config.instructions}
        onCommit={(instructions) => patch({ instructions })}
        rows={8}
        placeholder="What this agent does, how it should answer…"
      />
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
      <JsonSchemaEditor
        value={config.outputContract?.jsonSchema}
        onCommit={(jsonSchema) => patch({ outputContract: jsonSchema ? { jsonSchema } : {} })}
      />
      {/*
       * The contract a Review→Fix loop needs, in one press (§5 item 8): score, verdict and issues,
       * exactly as the contract defines them — so the loop's exit condition can read `verdict` and
       * the output is checked like any other (FR-PAR-004, FR-PAR-007).
       */}
      <Button
        variant="secondary"
        size="sm"
        data-testid="use-review-contract"
        disabled={usesReviewContract}
        title={
          usesReviewContract
            ? 'This agent already outputs the standard review contract.'
            : 'Fill the output contract with score, verdict and issues.'
        }
        onClick={() =>
          patch({
            outputContract: { jsonSchema: JSON.parse(reviewContract) as Record<string, unknown> },
          })
        }
      >
        Use standard review contract
      </Button>
      <ExecutionFields
        execution={config.execution}
        onChange={(execution) => patch({ execution })}
      />
      <NumberField
        label="Context budget (tokens)"
        value={config.contextPolicy.budgetTokens}
        range={BUDGET_RANGE}
        onCommit={(budgetTokens) => patch({ contextPolicy: { budgetTokens } })}
      />
      <AgentToolsSection tools={config.tools} onChange={(tools) => patch({ tools })} />
      <LaterField label="Skills" round="Round 6+" testId="skills" />
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
  config,
  patch,
}: {
  config: ModelConfig;
  patch: PatchConfig<ModelConfig>;
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
      <TextAreaField
        label="System prompt"
        value={config.systemPrompt ?? ''}
        onCommit={(systemPrompt) => patch({ systemPrompt })}
        rows={6}
      />
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
      <ExecutionFields
        execution={config.execution}
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

export function OutputPanel() {
  return (
    <Field label="Output">
      <p className="rounded-md border border-dashed border-border p-3 font-human text-sm italic text-fg-muted">
        final result appears here after a run
      </p>
    </Field>
  );
}

/** Dispatch on kind so `config` narrows; kinds from later rounds get a note. */
export function KindPanel({
  node,
  patch,
  workflowId,
  projectId,
}: {
  node: Node;
  patch: (patch: Partial<Node['config']>) => void;
  workflowId: string;
  /** The node's project, for the guardrail policy picker (FR-GRD-002). */
  projectId?: Id;
}) {
  // the route names the project on the Canvas; the workflow itself names it everywhere else
  const workflowProjectId = useWorkflowProjectId(workflowId);
  const project = projectId ?? workflowProjectId;
  switch (node.kind) {
    case 'agent':
      return (
        <AgentPanel
          config={node.config}
          patch={patch as PatchConfig<AgentConfig>}
          {...(project === undefined ? {} : { projectId: project })}
        />
      );
    case 'model':
      return <ModelPanel config={node.config} patch={patch as PatchConfig<ModelConfig>} />;
    case 'input':
      return (
        <InputPanel
          config={node.config}
          patch={patch as PatchConfig<InputConfig>}
          workflowId={workflowId}
          nodeId={node.id}
        />
      );
    case 'merge':
      return (
        <MergePanel
          node={node}
          config={node.config}
          patch={patch as PatchConfig<MergeConfig>}
          workflowId={workflowId}
        />
      );
    case 'transform':
      return <TransformPanel config={node.config} patch={patch as PatchConfig<TransformConfig>} />;
    case 'output':
      return <OutputPanel />;
    case 'retrieval':
      return (
        <RetrievalPanel
          config={node.config}
          patch={patch as PatchConfig<RetrievalConfig>}
          projectId={project}
        />
      );
    default:
      return <p className="text-sm text-fg-muted">This node kind arrives in a later round.</p>;
  }
}
