# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats —
unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor
tool calls as JSON — and mend reads each one the way `SPEC.md` says, changing every file or nothing.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file relative to the working directory (the tree's root); with no `PATCH`, or `-`, the patch
is read from standard input. `--format` is one of `unified`, `search-replace`, `v4a`, `json`, or `auto` (the
default: detect it). `--check` reports what would change without writing. `--strict` matches lines exactly.

## Approach

The entry is one self-contained `main.ts` (Node's standard library alone), built from the kit's starter and
completed with the three readers the starter leaves open, plus the line matching they share:

- **Three-tier matching (SPEC §5).** Hunk, block and chunk old-lines are looked up first exactly, then with
  trailing whitespace ignored, then with leading whitespace ignored too. Context lines are written back as the
  file's own lines; at the loosest tier the new lines are re-indented from the patch's indentation to the
  file's. Unified hunks pick the occurrence nearest the position their (often wrong) line numbers claim,
  corrected by the running length change of the hunks before them.
- **Unified diffs (§6).** Sections from `diff --git` or bare `--- `/`+++ ` pairs, with creations, deletions and
  renames, per-hunk `\ No newline` handling, and bodies that tolerate blank context lines and surrounding prose.
- **SEARCH/REPLACE (§7).** Blocks take their path from the nearest non-blank, non-fence line above them (or the
  previous block's path) and must match exactly once.
- **V4A (§8).** Add/Delete/Update sections with `*** Move to:`, anchored chunks that advance a cursor through
  the file, and `*** End of File` chunks pinned to the file's last line.
- **JSON edits (§9)** and the command line, output and all-or-nothing write (§§1–4, 10) follow the starter:
  every edit applies to an in-memory tree, failures are collected and reported in patch order, and nothing is
  written unless every edit succeeded. Successful moves print one `R <old> -> <new>` line.

`runner.ts` is the kit's trial runner, kept as it is; `check.ts` runs the public practice set against `main.ts`.
