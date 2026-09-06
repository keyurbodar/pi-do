import { useCallback, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { VfsTree, type VfsRow } from '../components/panels/VfsTree';
import { api } from '../lib/hc-client';

/**
 * Files list loader against the hc-client shell. The hono `hc` typed
 * client plugs in next phase; this keeps its path/query shape so call
 * sites do not change.
 */
async function listWorkspaceFiles(
  workspaceId: string,
  path: string,
): Promise<VfsRow[]> {
  const query = new URLSearchParams({ path });
  return api<VfsRow[]>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/files?${query}`,
  );
}

export function FilesPage() {
  const search = useSearch({ strict: false }) as {
    workspaceId?: unknown;
  };
  const workspaceId =
    typeof search.workspaceId === 'string' ? search.workspaceId : '';

  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const loadChildren = useCallback(
    (path: string) => listWorkspaceFiles(workspaceId, path),
    [workspaceId],
  );

  return (
    <section aria-label="VFS browser">
      <h1>Files</h1>
      {workspaceId === '' ? (
        <p role="status">Open a workspace to browse its files.</p>
      ) : (
        <VfsTree
          workspaceId={workspaceId}
          loadChildren={loadChildren}
          onSelect={setSelectedPath}
          selectedPath={selectedPath}
        />
      )}
    </section>
  );
}
