import { api } from '../app/api';

/** FR-WF-007: fetch the export (no secrets by contract) and hand it to the browser as a file. */
export async function downloadWorkflowExport(workflowId: string, name: string): Promise<void> {
  const file = await api().exportWorkflow(workflowId);
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${name.replace(/[^\w-]+/g, '-') || 'workflow'}.ace.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
