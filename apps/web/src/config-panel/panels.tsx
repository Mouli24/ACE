import {
  MERGE_MODES,
  ROUTING_POLICIES,
  TRANSFORM_OPS,
  type AgentConfig,
  type InputConfig,
  type MergeConfig,
  type ModelConfig,
  type Node,
  type TransformConfig,
} from '@ace/contracts';

import { JsonSchemaEditor } from './JsonSchemaEditor';
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

const NO_PROVIDERS_HINT = 'add a provider in Round 2';

/** D12: only fixed and fallback are offered in v1. */
const ROUTING_OPTIONS = ROUTING_POLICIES.filter((p) => p === 'fixed' || p === 'fallback').map(
  (p) => ({ value: p, label: p }),
);

function ProviderAndModel() {
  return (
    <>
      <SelectField
        label="Provider"
        value={undefined}
        options={[]}
        onChange={() => undefined}
        disabled
        placeholder="none"
        hint={NO_PROVIDERS_HINT}
      />
      <SelectField
        label="Model"
        value={undefined}
        options={[]}
        onChange={() => undefined}
        disabled
        placeholder="no model"
      />
    </>
  );
}

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
}: {
  config: AgentConfig;
  patch: PatchConfig<AgentConfig>;
}) {
  return (
    <>
      <ProviderAndModel />
      <SelectField
        label="Routing policy"
        value={config.routing.policy}
        options={ROUTING_OPTIONS}
        onChange={(policy) => patch({ routing: { ...config.routing, policy } })}
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
      <LaterField label="Tools" round="Round 4" testId="tools" />
      <LaterField label="Skills" round="Round 6+" testId="skills" />
      <LaterField label="Memory" round="Round 5" testId="memory" />
      <LaterField label="Guardrail policy" round="Round 3" testId="guardrail-policy" />
      <LaterField label="Knowledge bases" round="Round 5" testId="knowledge-bases" />
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
      <ProviderAndModel />
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
}: {
  config: InputConfig;
  patch: PatchConfig<InputConfig>;
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
      <LaterField label="Files" round="Round 4" testId="files" />
    </>
  );
}

export function MergePanel({
  config,
  patch,
}: {
  config: MergeConfig;
  patch: PatchConfig<MergeConfig>;
}) {
  return (
    <SelectField
      label="Mode"
      value={config.mode}
      options={MERGE_MODES.map((m) => ({ value: m, label: m }))}
      onChange={(mode) => patch({ mode })}
      hint="all: wait for every input · any: continue on the first"
    />
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
}: {
  node: Node;
  patch: (patch: Partial<Node['config']>) => void;
}) {
  switch (node.kind) {
    case 'agent':
      return <AgentPanel config={node.config} patch={patch as PatchConfig<AgentConfig>} />;
    case 'model':
      return <ModelPanel config={node.config} patch={patch as PatchConfig<ModelConfig>} />;
    case 'input':
      return <InputPanel config={node.config} patch={patch as PatchConfig<InputConfig>} />;
    case 'merge':
      return <MergePanel config={node.config} patch={patch as PatchConfig<MergeConfig>} />;
    case 'transform':
      return <TransformPanel config={node.config} patch={patch as PatchConfig<TransformConfig>} />;
    case 'output':
      return <OutputPanel />;
    default:
      return <p className="text-sm text-fg-muted">This node kind arrives in a later round.</p>;
  }
}
