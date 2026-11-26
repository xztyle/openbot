import { fileViewKind } from "@openbot/contracts/file-view-kind";
import { type ArchiveListing, decodeArchiveListing } from "@openbot/contracts/team-protocol/attachment-renditions-v1";
import { Button, ChevronDown, ChevronRight, Download, Folder, FolderOpen } from "@openbot/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { useText } from "../../text";
import { FileKindIcon } from "./AttachmentInlinePreviews";

interface TreeNode {
  name: string;
  /** The entry path as the archive names it, for a file. */
  path: string;
  size: number;
  directory: boolean;
  children: TreeNode[];
}

/** Folders first, then files, each by name. */
function buildTree(listing: ArchiveListing): TreeNode {
  const root: TreeNode = { name: "", path: "", size: 0, directory: true, children: [] };
  const folders = new Map<string, TreeNode>([["", root]]);
  const folder = (key: string): TreeNode => {
    const known = folders.get(key);
    if (known) return known;
    const parts = key.split("/");
    const node: TreeNode = { name: parts.at(-1) ?? key, path: `${key}/`, size: 0, directory: true, children: [] };
    folders.set(key, node);
    folder(parts.slice(0, -1).join("/")).children.push(node);
    return node;
  };
  for (const entry of listing.entries) {
    // A leading `./` is how some tools write the top folder; it is not a folder of its own.
    const parts = entry.path
      .replace(/^(\.\/)+/u, "")
      .split("/")
      .filter(Boolean);
    if (!parts.length) continue;
    if (entry.directory) {
      folder(parts.join("/"));
      continue;
    }
    const parent = folder(parts.slice(0, -1).join("/"));
    parent.children.push({
      name: parts.at(-1) ?? entry.path,
      path: entry.path,
      size: entry.size,
      directory: false,
      children: [],
    });
  }
  const sort = (node: TreeNode) => {
    node.children.sort((left, right) =>
      left.directory === right.directory ? left.name.localeCompare(right.name) : left.directory ? -1 : 1,
    );
    for (const child of node.children) {
      if (!child.directory) continue;
      sort(child);
      child.size = child.children.reduce((sum, item) => sum + item.size, 0);
    }
  };
  sort(root);
  return root;
}

/** The files of a ZIP or TAR as a folder tree. A file opens in the same viewer; the whole archive downloads. */
export function ArchiveFilePreview(props: {
  bytes: Uint8Array | null;
  name: string;
  onOpenEntry?: ((path: string) => void) | undefined;
  onDownloadAll?: (() => void) | undefined;
}) {
  const { t, format } = useText();
  const listing = createMemo(() => {
    if (!props.bytes) return null;
    try {
      return decodeArchiveListing(JSON.parse(new TextDecoder().decode(props.bytes)));
    } catch {
      return null;
    }
  });
  const tree = createMemo(() => {
    const value = listing();
    return value ? buildTree(value) : null;
  });
  const count = () => listing()?.entries.filter((entry) => !entry.directory).length ?? 0;
  return (
    <div class="archive-preview">
      <div class="archive-preview-summary">
        <span>{t("preview.archive.count", { count: count() })}</span>
        <Show when={props.onDownloadAll}>
          {(download) => (
            <Button variant="outline" type="button" onClick={() => download()()}>
              <Download aria-hidden="true" />
              {t("preview.archive.downloadAll")}
            </Button>
          )}
        </Show>
      </div>
      <Show when={tree()} fallback={<p class="file-preview-folder-empty">{t("preview.unavailable")}</p>}>
        {(root) => (
          <ul class="archive-tree" aria-label={props.name}>
            <For each={root().children}>
              {(node) => <ArchiveNode node={node} depth={0} onOpen={props.onOpenEntry} format={format} />}
            </For>
          </ul>
        )}
      </Show>
      <Show when={listing()?.truncated}>
        <p class="file-preview-truncated">{t("preview.archive.truncated", { limit: format.number(count()) })}</p>
      </Show>
    </div>
  );
}

function ArchiveNode(props: {
  node: TreeNode;
  depth: number;
  onOpen?: ((path: string) => void) | undefined;
  format: ReturnType<typeof useText>["format"];
}) {
  // The top folders start open, so a ZIP of one folder shows its files at once.
  const [open, setOpen] = createSignal(props.depth < 1);
  return (
    <li>
      <Button
        aria-expanded={props.node.directory ? (open() ? "true" : "false") : undefined}
        variant="ghost"
        type="button"
        class="archive-tree-row"
        style={{ "--archive-depth": String(props.depth) }}
        disabled={!props.node.directory && !props.onOpen}
        onClick={() => (props.node.directory ? setOpen((value) => !value) : props.onOpen?.(props.node.path))}
      >
        <Show
          when={props.node.directory}
          fallback={
            <>
              <span class="archive-tree-chevron" aria-hidden="true" />
              <FileKindIcon kind={fileViewKind(props.node.name, "")} class="file-preview-file-icon" />
            </>
          }
        >
          <span class="archive-tree-chevron" aria-hidden="true">
            <Show when={open()} fallback={<ChevronRight />}>
              <ChevronDown />
            </Show>
          </span>
          <Show when={open()} fallback={<Folder class="file-preview-file-icon" />}>
            <FolderOpen class="file-preview-file-icon" />
          </Show>
        </Show>
        <span class="file-preview-folder-name">{props.node.name}</span>
        <span class="file-preview-folder-meta">{props.format.fileSize(props.node.size)}</span>
      </Button>
      <Show when={props.node.directory && open()}>
        <ul>
          <For each={props.node.children}>
            {(child) => (
              <ArchiveNode node={child} depth={props.depth + 1} onOpen={props.onOpen} format={props.format} />
            )}
          </For>
        </ul>
      </Show>
    </li>
  );
}
