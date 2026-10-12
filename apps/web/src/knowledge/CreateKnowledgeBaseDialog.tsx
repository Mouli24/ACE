import {
  CreateKnowledgeBaseRequestSchema,
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  KNOWLEDGE_BASE_NAME_MAX,
  type Id,
  type Model,
  type Provider,
} from '@ace/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@ace/ui';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { ProviderMark } from '../providers/ProviderMark';
import { useModels, useProviders } from '../providers/hooks';
import { ChunkFields, FieldError, fieldErrors, toNumber, type FieldErrors } from './fields';
import { useCreateKnowledgeBase } from './hooks';

/**
 * The mock provider's embedder (round 5 §2.10). The catalogue has no "embedding" capability to
 * filter on — `mock-embed` declares text output like any chat model — so every model is offered and
 * this one is preselected when a provider has it.
 */
export const PREFERRED_EMBEDDING_MODEL_ID = 'mock-embed';

/** The provider and model to start the picker on: the first provider offering `mock-embed`. */
export function defaultEmbedder(
  providers: readonly Provider[],
  models: readonly Model[],
): { providerId: Id; modelId: string } | undefined {
  const preferred = models.find(
    (model) =>
      model.modelId === PREFERRED_EMBEDDING_MODEL_ID &&
      providers.some((provider) => provider.id === model.providerId),
  );
  if (preferred) return { providerId: preferred.providerId, modelId: preferred.modelId };
  const provider = providers[0];
  if (!provider) return undefined;
  const model = models.find((m) => m.providerId === provider.id);
  return { providerId: provider.id, modelId: model?.modelId ?? '' };
}

/**
 * "New knowledge base": name, embedder, chunking (FR-RAG-001, TC-RAG-001). The embedder is picked
 * with the theme's dropdowns, the provider with its orb (D328).
 */
export function CreateKnowledgeBaseDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: Id;
  onClose: () => void;
  onCreated: (id: Id) => void;
}) {
  const providers = useProviders();
  const models = useModels();
  const create = useCreateKnowledgeBase(projectId);

  const [name, setName] = useState('');
  const [providerId, setProviderId] = useState<Id>('');
  const [modelId, setModelId] = useState('');
  const [chunkSize, setChunkSize] = useState(String(DEFAULT_CHUNK_SIZE));
  const [chunkOverlap, setChunkOverlap] = useState(String(DEFAULT_CHUNK_OVERLAP));
  const [errors, setErrors] = useState<FieldErrors>({});

  const providerList = useMemo(() => providers.data ?? [], [providers.data]);
  const modelList = useMemo(() => models.data?.items ?? [], [models.data]);
  const providerModels = modelList.filter((model) => model.providerId === providerId);

  // Preselect once both lists are in and nothing has been chosen yet.
  const listsReady = providers.isSuccess && models.isSuccess;
  useEffect(() => {
    if (providerId !== '' || !listsReady) return;
    const initial = defaultEmbedder(providerList, modelList);
    if (initial) {
      setProviderId(initial.providerId);
      setModelId(initial.modelId);
    }
  }, [providerId, providerList, modelList, listsReady]);

  /*
   * The dropdowns ignore an empty value: inside a form, Radix's hidden native select reports ""
   * when the chosen value arrives before its option has rendered, which would undo the preselection.
   */
  const chooseProvider = (id: Id) => {
    setProviderId(id);
    const models = modelList.filter((model) => model.providerId === id);
    const preferred = models.find((model) => model.modelId === PREFERRED_EMBEDDING_MODEL_ID);
    setModelId((preferred ?? models[0])?.modelId ?? '');
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = CreateKnowledgeBaseRequestSchema.safeParse({
      name: name.trim(),
      embeddingProviderId: providerId,
      embeddingModelId: modelId,
      chunkSize: toNumber(chunkSize),
      chunkOverlap: toNumber(chunkOverlap),
    });
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    create.mutate(parsed.data, { onSuccess: (kb) => onCreated(kb.id) });
  };

  const noProviders = providers.isSuccess && providerList.length === 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-[calc(100vw-2rem)] overflow-y-auto sm:max-w-[560px]">
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>New knowledge base</DialogTitle>
            <DialogDescription>
              Documents you upload are split into chunks and embedded with the model you pick here.
              The embedder cannot be changed later.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-[7px]">
            <Label htmlFor="kb-name">Name</Label>
            <Input
              id="kb-name"
              value={name}
              maxLength={KNOWLEDGE_BASE_NAME_MAX}
              autoFocus
              aria-invalid={errors['name'] ? true : undefined}
              aria-describedby={errors['name'] ? 'kb-name-error' : undefined}
              onChange={(event) => setName(event.target.value)}
            />
            <FieldError id="kb-name-error" message={errors['name']} />
          </div>

          {noProviders ? (
            <p role="alert" className="text-[12px] text-[#c94c27]">
              No providers yet. <Link to="/providers">Add a provider</Link> (the built-in Mock
              provider works offline) to pick an embedding model.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-x-4 gap-y-5 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-[7px]">
                <Label htmlFor="kb-embedding-provider">Embedding provider</Label>
                <Select value={providerId} onValueChange={(id) => id && chooseProvider(id)}>
                  <SelectTrigger
                    id="kb-embedding-provider"
                    aria-label="Embedding provider"
                    aria-invalid={errors['embeddingProviderId'] ? true : undefined}
                    className="aria-[invalid=true]:border-[#c94c27]"
                  >
                    <SelectValue placeholder="Choose a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    {providerList.map((provider) => (
                      <SelectItem
                        key={provider.id}
                        value={provider.id}
                        icon={<ProviderMark type={provider.type} />}
                      >
                        {provider.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError
                  id="kb-embedding-provider-error"
                  message={errors['embeddingProviderId'] && 'Choose an embedding provider.'}
                />
              </div>
              <div className="flex min-w-0 flex-col gap-[7px]">
                <Label htmlFor="kb-embedding-model">Embedding model</Label>
                <Select
                  value={modelId}
                  onValueChange={(id) => id && setModelId(id)}
                  disabled={providerId === ''}
                >
                  <SelectTrigger
                    id="kb-embedding-model"
                    aria-label="Embedding model"
                    aria-invalid={errors['embeddingModelId'] ? true : undefined}
                    className="aria-[invalid=true]:border-[#c94c27]"
                  >
                    <SelectValue placeholder="Choose a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {providerModels.map((model) => (
                      <SelectItem key={model.modelId} value={model.modelId}>
                        {model.displayName} ({model.modelId})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError
                  id="kb-embedding-model-error"
                  message={errors['embeddingModelId'] && 'Choose an embedding model.'}
                />
              </div>
            </div>
          )}

          <ChunkFields
            idPrefix="kb-create"
            chunkSize={chunkSize}
            chunkOverlap={chunkOverlap}
            errors={errors}
            onChunkSize={setChunkSize}
            onChunkOverlap={setChunkOverlap}
          />

          {create.error && (
            <p role="alert" className="text-[12px] text-[#c94c27]">
              {create.error.message}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || noProviders}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
