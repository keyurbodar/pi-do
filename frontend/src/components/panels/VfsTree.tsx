import { useEffect, useReducer, useRef } from 'react';
import {
  asyncDataLoaderFeature,
  createTree,
  hotkeysCoreFeature,
  selectionFeature,
  type TreeInstance,
} from '@headless-tree/core';
import { ChevronDown, ChevronRight, File, Folder } from 'lucide-react';

export interface VfsRow {
  id: string;
  name: string;
  kind: 'dir' | 'file';
}

export interface VfsTreeProps {
  workspaceId: string;
  loadChildren: (path: string) => Promise<VfsRow[]>;
  onSelect: (path: string) => void;
  selectedPath: string | null;
}

/** Synthetic root id. Real row ids are workspace paths, so this prefix
 *  can never collide with a row returned by loadChildren. */
function rootIdFor(workspaceId: string): string {
  return `vfs-root:${workspaceId}`;
}

function baseName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/**
 * VFS file tree on @headless-tree/core. Children load lazily: expanding a
 * directory fetches exactly one level via loadChildren, and nothing else is
 * ever prefetched. Keyboard navigation comes from hotkeysCoreFeature;
 * drag and drop stays off (no dnd features registered).
 */
export function VfsTree({
  workspaceId,
  loadChildren,
  onSelect,
  selectedPath,
}: VfsTreeProps) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  // Row cache so getItem resolves synchronously for anything the loader
  // has already returned. Unknown ids get a file placeholder until data
  // arrives; guards below keep null data from reaching the render.
  const rowsRef = useRef(new Map<string, VfsRow>());

  // Latest callbacks without rebuilding the tree (which would drop
  // expansion state) on every parent render.
  const loaderRef = useRef(loadChildren);
  loaderRef.current = loadChildren;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const rootItemId = rootIdFor(workspaceId);
  const treeRef = useRef<TreeInstance<VfsRow> | null>(null);
  if (
    treeRef.current === null ||
    treeRef.current.getConfig().rootItemId !== rootItemId
  ) {
    const rows = rowsRef.current;
    rows.clear();
    treeRef.current = createTree<VfsRow>({
      rootItemId,
      dataLoader: {
        getItem: (itemId) => {
          if (itemId === rootItemId) {
            return { id: rootItemId, name: workspaceId, kind: 'dir' };
          }
          return (
            rows.get(itemId) ?? {
              id: itemId,
              name: baseName(itemId),
              kind: 'file',
            }
          );
        },
        getChildrenWithData: async (itemId) => {
          const path = itemId === rootItemId ? '' : itemId;
          const children = await loaderRef.current(path);
          return children.map((row) => {
            rows.set(row.id, row);
            return { id: row.id, data: row };
          });
        },
      },
      getItemName: (item) =>
        (item.getItemData() as VfsRow | null)?.name ?? item.getId(),
      isItemFolder: (item) =>
        item.getId() === rootItemId ||
        (item.getItemData() as VfsRow | null)?.kind === 'dir',
      onPrimaryAction: (item) => {
        selectRef.current(item.getId());
      },
      features: [asyncDataLoaderFeature, selectionFeature, hotkeysCoreFeature],
      // Every internal state change (expand, focus, select, load) funnels
      // through here; a rerender is all the binding needs.
      setState: () => {
        rerender();
      },
    });
  }
  const tree = treeRef.current;

  useEffect(() => {
    tree.setMounted(true);
    tree.rebuildTree();
    return () => {
      tree.setMounted(false);
    };
  }, [tree]);

  useEffect(() => {
    tree.setSelectedItems(selectedPath ? [selectedPath] : []);
  }, [tree, selectedPath]);

  const items = tree.getItems();
  const loadingRoot = tree
    .getState()
    .loadingItemChildrens.includes(rootItemId);

  return (
    <div {...tree.getContainerProps('Workspace files')}>
      {items.length === 0 ? (
        <p role="status" className="px-2 py-1.5 text-sm text-ink-2">
          {loadingRoot ? 'Loading files…' : 'No files in this workspace.'}
        </p>
      ) : (
        items.map((item) => {
          const meta = item.getItemMeta();
          const data = item.getItemData() as VfsRow | null;
          const id = item.getId();
          const folder = item.isFolder();
          const expanded = item.isExpanded();
          const selected = selectedPath === id;
          // skipFetch: show a count only for levels already in cache so the
          // badge itself never triggers a fetch.
          const childCount = folder
            ? tree.retrieveChildrenIds(id, true).length
            : 0;
          const loading = item.isLoading();
          return (
            <div
              key={item.getKey()}
              {...item.getProps()}
              aria-selected={selected}
              className={
                selected
                  ? 'flex h-8 items-center gap-2 border-l-2 border-line-strong bg-hover-2 px-2 font-mono text-sm text-ink hover:bg-hover focus-visible:bg-hover'
                  : 'flex h-8 items-center gap-2 border-l-2 border-transparent px-2 font-mono text-sm text-ink hover:bg-hover focus-visible:bg-hover'
              }
              style={{
                paddingLeft: `calc(var(--spacing) * ${meta.level * 4 + 2})`,
              }}
            >
              <span aria-hidden="true" className="text-ink-3">
                {loading ? (
                  <span className="inline-block size-4" />
                ) : folder ? (
                  expanded ? (
                    <ChevronDown className="size-4" />
                  ) : (
                    <ChevronRight className="size-4" />
                  )
                ) : (
                  <span className="inline-block size-4" />
                )}
              </span>
              <span aria-hidden="true" className="text-ink-2">
                {folder ? (
                  <Folder className="size-4" />
                ) : (
                  <File className="size-4" />
                )}
              </span>
              <span className="truncate">{data?.name ?? id}</span>
              {folder && childCount > 0 ? (
                <span className="ml-auto rounded-chip bg-surface px-1.5 text-xs tabular-nums text-ink-2">
                  {childCount}
                </span>
              ) : null}
            </div>
          );
        })
      )}
    </div>
  );
}
