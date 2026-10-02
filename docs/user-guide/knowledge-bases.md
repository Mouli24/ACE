# Knowledge bases

A **knowledge base** lets an agent answer from your own documents and cite them.

## Create one

Open **Knowledge** in a project and create a base: give it a name, pick an embedding model (the Mock
provider has one that needs no key), and set the chunk size and overlap. The embedding model cannot
be changed afterwards, because vectors from two models cannot be searched together.

## Add documents

Upload PDF, DOCX, Markdown, text, code or HTML files. Each document shows its status and progress
while it is read, split into chunks and indexed. A file that cannot be read is marked failed with
the reason, and the others are not affected. You can delete a document, or reindex the
whole base after changing its chunk settings.

## Test search

Before you use a base, try it: type a query, choose how many results and the search mode, and read
the matching chunks with their scores and sources.

## Use it in a workflow

- **Attach it to an agent:** pick it under **Knowledge bases** in the Agent's config. The agent
  receives the most relevant chunks on every run.
- **Add a Retrieval node:** connect a question to its `query` input. Its `json` output carries the
  hits to the next node.

After a run, the Inspector lists the **Sources** a node used, with chunk ids and scores. Retrieved
text is always labelled untrusted in the prompt, so an instruction hidden in a document is not
obeyed.

The **RAG Q&A** template creates a base with a sample document already in it.

See also: [Guardrails](guardrails.md).
