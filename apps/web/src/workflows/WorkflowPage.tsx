import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { useParams } from 'react-router-dom';

import { QueryError } from '../app/QueryError';
import { useWorkflowSubscription } from '../app/socket';
import { usePanelsStore } from '../app/stores/panels';
import { BottomPanel } from '../bottom-panel/BottomPanel';
import { Canvas } from '../canvas/Canvas';
import { Palette } from '../canvas/Palette';
import { useCanvasApi } from '../canvas/canvas-api';
import { ConfigPanel } from '../config-panel/ConfigPanel';
import { useWorkflowGraph } from './hooks';

const handle = 'bg-border transition-colors data-[resize-handle-state=drag]:bg-accent';

/**
 * The Canvas screen (Arch §33.1 step 5): left palette · centre Canvas over the bottom panel ·
 * right config panel, all resizable (round 1 §5 step 3).
 */
export function WorkflowPage() {
  const { projectId = '', workflowId = '' } = useParams();
  const graph = useWorkflowGraph(workflowId);
  useWorkflowSubscription(workflowId);
  const { paletteOpen, configOpen, bottomOpen } = usePanelsStore();
  const canvasApi = useCanvasApi((s) => s.api);

  if (graph.isError) {
    return (
      <QueryError
        error={graph.error}
        what="workflow"
        backTo={`/projects/${projectId}`}
        backLabel="Back to the project"
      />
    );
  }

  return (
    <PanelGroup direction="horizontal" className="h-full">
      {paletteOpen && (
        <>
          <Panel defaultSize={14} minSize={8} maxSize={30} className="bg-panel">
            <Palette workflowId={workflowId} onAdd={(kind) => canvasApi?.addNode(kind)} />
          </Panel>
          <PanelResizeHandle className={`w-px ${handle}`} />
        </>
      )}
      <Panel minSize={30}>
        <PanelGroup direction="vertical" className="h-full">
          {/* `relative` + an absolutely filled Canvas: a percentage height inside a flex-sized
              panel collapses to 0, which left the Canvas unmeasurable (no fit, no minimap). */}
          <Panel minSize={30} className="relative min-h-0">
            <Canvas workflowId={workflowId} />
          </Panel>
          {bottomOpen && (
            <>
              <PanelResizeHandle className={`h-px ${handle}`} />
              <Panel defaultSize={22} minSize={8} maxSize={60}>
                <BottomPanel workflowId={workflowId} />
              </Panel>
            </>
          )}
        </PanelGroup>
      </Panel>
      {configOpen && (
        <>
          <PanelResizeHandle className={`w-px ${handle}`} />
          <Panel defaultSize={24} minSize={12} maxSize={45} className="bg-panel">
            <ConfigPanel workflowId={workflowId} />
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}
