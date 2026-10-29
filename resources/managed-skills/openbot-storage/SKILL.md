---
name: openbot-storage
description: Keep the shared disk small while you build, test and take screenshots. Use before you clone or copy a project, start a Rust, Node or Godot build, make a worktree, or save evidence (screenshots, recordings, builds) for a report.
---

# Disk hygiene in shared projects

All agents share one disk. Build output, caches, copies and screenshots fill it fast: one Rust `target/` can be 20 GB. The owner can clean up from the workspace Storage view, but do not make the mess.

## Builds and caches

- Keep build output in the project's own `target/`, `build/`, `dist/` or `node_modules/`. Never move or copy it somewhere else.
- Rust: share one target folder across clones of the same repository: `export CARGO_TARGET_DIR=<project>/.cache/cargo-target` (for example `~/OpenBot/Shared/piks/.cache/cargo-target`). If `sccache` is installed, also set `RUSTC_WRAPPER=sccache`.
- Prefer one clone and `git worktree add` to a second full clone. Do not clone a repository again when a clone exists in the project.

## Notes and evidence folders

- `notes/`, `evidence/` and `screenshots/` hold what a report needs: text, a few screenshots, short logs.
- Never copy a repository, a `.git` folder, a build (`.pck`, `.x86_64`, `.exe`, `.zip`), a `.godot` folder or `node_modules` into them. Link to the commit or the branch instead.
- Save screenshots as WebP at quality 80 (`cwebp -q 80 in.png -o out.webp`, or `magick in.png -quality 80 out.webp`), or as a PNG scaled down to the size the report needs. Keep only the screenshots the report shows.

## When the task is done

- After your work is merged, remove your worktree (`git worktree remove <path>`) and any copy of the project you made.
- Delete temporary builds, recordings and downloads that the report does not need.
