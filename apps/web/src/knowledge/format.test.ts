import { documentTypeLabel, highlightSegments, queryTerms, stageProgress } from './format';

describe('FR-RAG-008 query-term highlighting', () => {
  it('keeps a hyphenated rare term whole and drops short and stop words', () => {
    expect(queryTerms('the zephyrine-protocol-7, a runbook?')).toEqual([
      'zephyrine-protocol-7',
      'runbook',
    ]);
  });

  it('marks every case-insensitive match and leaves the rest plain', () => {
    expect(highlightSegments('Leave and LEAVE policy', ['leave'])).toEqual([
      { text: 'Leave', match: true },
      { text: ' and ', match: false },
      { text: 'LEAVE', match: true },
      { text: ' policy', match: false },
    ]);
    expect(highlightSegments('plain', [])).toEqual([{ text: 'plain', match: false }]);
  });

  it('escapes regex characters in terms', () => {
    expect(highlightSegments('a (b) c', ['(b)']).filter((s) => s.match)).toEqual([
      { text: '(b)', match: true },
    ]);
  });
});

describe('FR-RAG-002 document type labels and stage progress', () => {
  it('labels by extension, then mime, then as code', () => {
    expect(documentTypeLabel('a.pdf', 'application/pdf')).toBe('PDF');
    expect(documentTypeLabel('a.md', 'text/markdown')).toBe('Markdown');
    expect(documentTypeLabel('notes', 'text/plain')).toBe('Text');
    expect(documentTypeLabel('retry.ts', 'text/typescript')).toBe('Code (ts)');
    expect(documentTypeLabel('blob', 'application/octet-stream')).toBe('application/octet-stream');
  });

  it('orders the stages through the pipeline', () => {
    expect(stageProgress('pending')).toBeLessThan(stageProgress('parsing'));
    expect(stageProgress('chunking')).toBeLessThan(stageProgress('embedding'));
    expect(stageProgress('ready')).toBe(1);
  });
});
