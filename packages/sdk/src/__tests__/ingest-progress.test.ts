import type { KbDocument, KbIngestPayload, ServerFrame } from '@ace/contracts';
import { describe, expect, it } from 'vitest';

import { IngestProgressBuffer, applyKbIngest } from '../index.js';

const KB = '01ARZ3NDEKTSV4RRFFQ69G5FE0';
const OTHER_KB = '01ARZ3NDEKTSV4RRFFQ69G5FE9';
const DOC = '01ARZ3NDEKTSV4RRFFQ69G5FE1';
const DOC2 = '01ARZ3NDEKTSV4RRFFQ69G5FE2';
const ART = '01ARZ3NDEKTSV4RRFFQ69G5FD0';
const NODE = '01ARZ3NDEKTSV4RRFFQ69G5FB2';
const NOW = '2026-10-02T00:00:00.000Z';

const ingest = (
  seq: number,
  payload: Partial<KbIngestPayload> & Pick<KbIngestPayload, 'status'>,
): ServerFrame =>
  ({
    type: 'kb.ingest',
    payload: { knowledgeBaseId: KB, documentId: DOC, ...payload },
    seq,
  }) as ServerFrame;

describe('IngestProgressBuffer (round 5 §2.8, FR-RAG-003)', () => {
  it('keeps the latest status and progress per document through the pipeline', () => {
    const buffer = new IngestProgressBuffer(KB);
    buffer.apply(ingest(1, { status: 'pending', progress: 0 }));
    buffer.apply(ingest(2, { status: 'parsing', progress: 0.2 }));
    buffer.apply(ingest(3, { status: 'chunking', progress: 0.5 }));
    buffer.apply(ingest(4, { documentId: DOC2, status: 'parsing', progress: 0.1 }));

    const { view } = buffer;
    expect(view.lastSeq).toBe(4);
    expect(view.byDocument[DOC]).toEqual({ status: 'chunking', progress: 0.5, seq: 3 });
    expect(view.byDocument[DOC2]).toEqual({ status: 'parsing', progress: 0.1, seq: 4 });
    expect(view.settled(DOC)).toBe(false);
  });

  it('records a failure with its reason and reads ready/failed as settled', () => {
    const buffer = new IngestProgressBuffer();
    buffer.apply(ingest(1, { status: 'embedding', progress: 0.8 }));
    buffer.apply(ingest(2, { status: 'ready', progress: 1 }));
    buffer.apply(ingest(3, { documentId: DOC2, status: 'failed', error: 'Corrupt PDF' }));

    const { view } = buffer;
    expect(view.byDocument[DOC2]).toEqual({ status: 'failed', error: 'Corrupt PDF', seq: 3 });
    expect(view.settled(DOC)).toBe(true);
    expect(view.settled(DOC2)).toBe(true);
    // A document never seen is not settled: nothing is known about it yet.
    expect(view.settled('01ARZ3NDEKTSV4RRFFQ69G5FEZ')).toBe(false);
  });

  it('is idempotent on seq and never lets an older frame overwrite a newer one', () => {
    const buffer = new IngestProgressBuffer(KB);
    buffer.apply(ingest(5, { status: 'ready', progress: 1 }));
    buffer.apply(ingest(5, { status: 'ready', progress: 1 }));
    // A `resume` replay can deliver an older stage after a newer one.
    buffer.apply(ingest(3, { status: 'chunking', progress: 0.5 }));

    expect(buffer.view.byDocument[DOC]).toEqual({ status: 'ready', progress: 1, seq: 5 });
    expect(buffer.view.lastSeq).toBe(5);
  });

  it('a new stage drops a stale error or progress the earlier frame carried', () => {
    const buffer = new IngestProgressBuffer(KB);
    buffer.apply(ingest(1, { status: 'failed', error: 'Corrupt PDF' }));
    // A reindex starts the document over.
    buffer.apply(ingest(2, { status: 'pending' }));
    expect(buffer.view.byDocument[DOC]).toEqual({ status: 'pending', seq: 2 });
  });

  it('ignores other bases when filtered, and every other frame type', () => {
    const buffer = new IngestProgressBuffer(KB);
    buffer.apply(ingest(1, { knowledgeBaseId: OTHER_KB, status: 'parsing' }));
    buffer.apply({
      type: 'memory.updated',
      payload: { nodeId: NODE, ops: [{ op: 'delete', key: 'k' }] },
      seq: 2,
    } as ServerFrame);
    buffer.apply({ type: 'hello', payload: { seq: 9 } } as ServerFrame);

    expect(buffer.view.byDocument).toEqual({});
    expect(buffer.view.lastSeq).toBe(-1);
  });

  it('without a filter keeps every base’s documents', () => {
    const buffer = new IngestProgressBuffer();
    buffer.apply(ingest(1, { status: 'parsing' }));
    buffer.apply(ingest(2, { knowledgeBaseId: OTHER_KB, documentId: DOC2, status: 'parsing' }));
    expect(Object.keys(buffer.view.byDocument).sort()).toEqual([DOC, DOC2].sort());
  });

  it('reset forgets everything, including the seqs it has seen', () => {
    const buffer = new IngestProgressBuffer(KB);
    buffer.apply(ingest(1, { status: 'parsing' }));
    buffer.reset();
    expect(buffer.view.byDocument).toEqual({});
    expect(buffer.view.lastSeq).toBe(-1);
    buffer.apply(ingest(1, { status: 'parsing' }));
    expect(buffer.view.byDocument[DOC]?.status).toBe('parsing');
  });

  it('the view is a snapshot the caller cannot mutate the buffer through', () => {
    const buffer = new IngestProgressBuffer(KB);
    buffer.apply(ingest(1, { status: 'parsing' }));
    const view = buffer.view;
    delete view.byDocument[DOC];
    expect(buffer.view.byDocument[DOC]?.status).toBe('parsing');
  });
});

describe('applyKbIngest (round 5 §2.8, FR-RAG-003)', () => {
  const doc: KbDocument = {
    id: DOC,
    knowledgeBaseId: KB,
    artifactId: ART,
    name: 'handbook.md',
    mime: 'text/markdown',
    size: 10,
    status: 'pending',
    chunkCount: 0,
    createdAt: NOW,
  };

  it('patches the status and, on failure, the reason', () => {
    const parsing = applyKbIngest(doc, {
      knowledgeBaseId: KB,
      documentId: DOC,
      status: 'parsing',
      progress: 0.2,
    });
    expect(parsing).toEqual({ ...doc, status: 'parsing' });
    expect(parsing).not.toBe(doc);

    const failed = applyKbIngest(parsing, {
      knowledgeBaseId: KB,
      documentId: DOC,
      status: 'failed',
      error: 'Corrupt PDF',
    });
    expect(failed).toEqual({ ...doc, status: 'failed', error: 'Corrupt PDF' });
  });

  it('drops a stale error when the document moves on, and leaves other documents alone', () => {
    const failed: KbDocument = { ...doc, status: 'failed', error: 'Corrupt PDF' };
    const again = applyKbIngest(failed, {
      knowledgeBaseId: KB,
      documentId: DOC,
      status: 'pending',
    });
    expect(again).toEqual({ ...doc, status: 'pending' });
    expect('error' in again).toBe(false);

    const untouched = applyKbIngest(doc, {
      knowledgeBaseId: KB,
      documentId: DOC2,
      status: 'ready',
    });
    expect(untouched).toBe(doc);
  });
});
