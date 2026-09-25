import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ace/ui';
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels';
import { Link, useParams } from 'react-router-dom';

import { useWorkflowSubscription } from '../app/socket';
import { usePanelsStore } from '../app/stores/panels';
import { BottomPanel } from '../bottom-panel/BottomPanel';
import { Canvas } from '../canvas/Canvas';
import { Palette } from '../canvas/Palette';
import { useCanvasApi } from '../canvas/canvas-api';
import { ConfigPanel } from '../config-panel/ConfigPanel';
import { Inspector } from '../inspector/Inspector';
import { PreflightIssues } from '../runs/PreflightIssues';
import { RunsList } from '../runs/RunsList';
import { useAdoptActiveRun, useRunEvents } from '../runs/hooks';
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
  // Every §2.4 run frame folds into the overlay store while this screen is mounted (FR-EXE-008/009).
  useRunEvents(workflowId);
  // A reload mid-run rebuilds the overlay from the engine's records (FR-EXE-014, D-028).
  useAdoptActiveRun(workflowId);
  const { paletteOpen, configOpen, bottomOpen } = usePanelsStore();
  const canvasApi = useCanvasApi((s) => s.api);

  if (graph.isError) {
    return (
      <p role="alert" className="p-6 text-danger">
        Workflow not found.{' '}
        <Link to={`/projects/${projectId}`} className="underline">
          Back to the project
        </Link>
      </p>
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
            <PreflightIssues workflowId={workflowId} />
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
            {/* Configure what a node will do, or inspect what its run did (FR-EXE-010). */}
            <Tabs defaultValue="configure" className="flex h-full flex-col">
              <TabsList className="m-2">
                <TabsTrigger value="configure">Configure</TabsTrigger>
                <TabsTrigger value="inspect">Inspector</TabsTrigger>
                <TabsTrigger value="runs">Runs</TabsTrigger>
              </TabsList>
              <TabsContent value="configure" className="min-h-0 flex-1">
                <ConfigPanel workflowId={workflowId} />
              </TabsContent>
              <TabsContent value="inspect" className="min-h-0 flex-1">
                <Inspector workflowId={workflowId} />
              </TabsContent>
              <TabsContent value="runs" className="min-h-0 flex-1 overflow-y-auto">
                <RunsList workflowId={workflowId} />
              </TabsContent>
            </Tabs>
          </Panel>
        </>
      )}
    </PanelGroup>
  );
}
