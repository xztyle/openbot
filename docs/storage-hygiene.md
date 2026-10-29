# Storage hygiene

The agents' projects fill the disk with output that a build makes again: Rust `target/` folders in
each clone, `node_modules`, Godot `.godot` import caches, copies of repositories and game builds in
`notes/` evidence folders, worktrees and copies that nobody uses, and old screenshots. The workspace
Storage view shows where the space goes and removes what the owner picks. Only an owner or an admin
sees it; agents cannot start a cleanup.

## Where the storage is

| Area | Path on the host | In the Storage view |
| --- | --- | --- |
| Shared projects | `~/OpenBot/Shared/<project>` (`/data/OpenBot/Shared` in the Docker image) | One row per top-level folder |
| Agent workspaces | `~/OpenBot/Agents/<agent id>` | One row per agent |
| Scan cache, last result, audit | `<userData>/storage-hygiene/` (`scan-cache.json`, `last-cleanup.json`, `audit.jsonl`) | Not shown |
| Settings | `<userData>/openbot-storage-hygiene-v1.json` | Server settings > Storage > Cleanup rules |

The chats, attachments, caches and logs of OpenBot itself stay in Server settings > Storage.

## The scan

The scan runs in a background process (`src/backend/storage-hygiene-host.ts`) at the lowest CPU
priority and, on Linux, in the idle I/O class. It never follows a symbolic link and never leaves the
file system of an area. It counts disk blocks, as `du` does, and a hard-linked file once.

It is incremental. A folder whose modification time did not change keeps the file sizes of the scan
before, and a regenerable folder keeps its size for six hours. "Scan again" with no cache measures
everything. The view starts a scan when the last one is older than ten minutes.

On a warm cache, a full scan reads about 250,000 files and folders a second (300,000 files in about
1.2 s in `scripts/storage-hygiene-e2e.ts`); a tree of a few million files on a cold disk takes
minutes. A scan with the cache reads only the folders, so it takes a fraction of that.

## What the rules find

| Class | Rule | What it removes |
| --- | --- | --- |
| Regenerable | `cargo-target` | `target/` next to `Cargo.toml`, or a `target/` or `cargo-target/` folder with `CACHEDIR.TAG` |
| Regenerable | `node-modules` | `node_modules` |
| Regenerable | `godot-cache` | `.godot` |
| Regenerable | `build-output` | `dist`, `build`, `out` next to a project manifest, when git ignores the folder |
| Regenerable | `repo-copy` | A `.git` folder in an evidence folder whose branches, HEAD and stash are all in a canonical repository of the project. The copied files stay. |
| Regenerable | `build-export` | `.pck`, `.x86_64`, `.exe`, `.zip` files in an evidence folder |
| Stale | `stale-worktree` | A git worktree with no changes, merged into the main branch, with no change for `staleIdleHours` (default 24) |
| Stale | `stale-copy` | A folder without git in a `work`, `worktrees` or `copies` folder, or a repository nested in another work tree with no changes and no commit of its own, with no change for `staleIdleHours` |
| Evidence | `evidence-media` | Screenshots and recordings in an evidence folder older than `evidenceDeleteAfterDays` (default 30). Not selected by default. |

Evidence folders are folders named `notes`, `evidence`, `screenshots`, `captures` or `recordings`.
Everything else is work. A canonical repository (a `.git` folder outside evidence folders that is
not nested in another work tree) and source files are never removable.

## The cleanup

The owner or an admin selects rules and projects and confirms "Clean up". The host deletes only items
of its own plan, by id, and checks each one on the disk first. It keeps an item when:

- a process has its working folder in it (Linux `/proc/<pid>/cwd`, macOS `lsof`);
- a file in it changed in the last `recentMinutes` (default 30);
- a stale item is not idle any more, or a worktree or repository copy has new commits or changes;
- it crosses into another file system, or it is a symbolic link.

A worktree is removed with `git worktree remove`, and its repository is pruned. Each deletion and
each kept item is a line in `audit.jsonl` (time, trigger, person, rule, path, bytes, outcome). The
file rotates at 20 MB.

## Automatic rules

All are off by default (Server settings > Storage > Cleanup rules). The host checks them every 30
minutes.

- **Remove regenerable caches when the disk is full**: when the disk is fuller than
  `autoPruneDiskPercent` (default 85 %), delete regenerable items with no change for
  `autoPruneIdleHours` (default 24).
- **Convert old screenshots to WebP**: once a day, convert PNG screenshots in evidence folders older
  than `evidenceConvertAfterDays` (default 7) to WebP at quality 80 with `cwebp` or ImageMagick
  (`magick` or `convert`). Without a converter the rule does nothing. A screenshot stays when the
  WebP is not smaller. The WebP keeps the time of the PNG, and links in Markdown and HTML files of
  the folder and the folder above change to the new name.
- **Delete old evidence media**: once a day, delete the media of the `evidence-media` rule.

## Interfaces

- IPC: `window.openbot.storageHygiene.getState`, `apply`, `getSettings`, `setSettings`
  (`packages/contracts/src/ipc-storage-hygiene.ts`).
- Team API: `storage-hygiene-v1` under `fork-host-v1`, admin only
  (`packages/contracts/src/team-protocol/storage-hygiene-v1.ts`).

## Agent guidance

The developer instructions and the managed skill `openbot-storage` tell agents to keep build output
in the project's own folders, to share one Rust target folder across clones with
`CARGO_TARGET_DIR=<project>/.cache/cargo-target`, to never copy repositories, builds or caches into
evidence folders, to save screenshots as WebP, and to remove their worktrees and copies when the
task is merged.
