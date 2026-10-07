import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ace/ui';
import { Navigate, useNavigate, useParams } from 'react-router-dom';

import { BundlesTab } from './BundlesTab';
import { PluginsTab } from './PluginsTab';
import { SkillsTab } from './SkillsTab';
import { ToolsTab } from './ToolsLibraryPage';

/** The Library's tabs, in order; each is a route, `/library/<value>`. */
export const LIBRARY_TABS = [
  { value: 'tools', label: 'Tools' },
  { value: 'skills', label: 'Skills' },
  { value: 'plugins', label: 'Plugins' },
  { value: 'bundles', label: 'Bundles' },
] as const;

export type LibraryTab = (typeof LIBRARY_TABS)[number]['value'];

const isLibraryTab = (value: string | undefined): value is LibraryTab =>
  LIBRARY_TABS.some((tab) => tab.value === value);

/**
 * `/library/:tab` (Arch §33.2; ACE parity P1, D272, D273): what agents can use — the tool
 * registry, skills, plugins (MCP servers) and the bundles that share them. Installing or
 * connecting anything here enables it for no agent; each agent chooses in its own config. An
 * unknown tab goes to Tools, and so does `/library`.
 */
export function LibraryPage() {
  const { tab } = useParams();
  const navigate = useNavigate();
  if (!isLibraryTab(tab)) return <Navigate to="/library/tools" replace />;

  return (
    <main
      data-testid="library-page"
      className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 overflow-y-auto px-4 py-10"
    >
      <header>
        <h1 className="font-human text-2xl font-semibold">Library</h1>
        <p className="mt-1 font-human text-sm text-fg-muted">
          What your agents can use: tools, skills, plugins and the bundles that share them.
          Installing something here turns it on for no agent — each agent chooses its own.
        </p>
      </header>

      <Tabs
        value={tab}
        onValueChange={(next) => navigate(`/library/${next}`)}
        className="flex flex-col gap-6"
      >
        <TabsList aria-label="Library sections" className="self-start">
          {LIBRARY_TABS.map(({ value, label }) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="tools">
          <ToolsTab />
        </TabsContent>
        <TabsContent value="skills">
          <SkillsTab />
        </TabsContent>
        <TabsContent value="plugins">
          <PluginsTab />
        </TabsContent>
        <TabsContent value="bundles">
          <BundlesTab />
        </TabsContent>
      </Tabs>
    </main>
  );
}
