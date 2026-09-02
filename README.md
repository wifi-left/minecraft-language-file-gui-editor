# Minecraft Language File GUI Editor

A VS Code extension that gives Minecraft (datapack / resourcepack / mod) language files a friendly multi-language GUI editor. The editor is registered as a **native custom editor ("Open With…")** — it **never intercepts normal file opening**; open it explicitly when you want it. New / deleted / renamed translation keys are applied to **every sibling language file at once**, with undo/redo.

**[English](README.md) · [简体中文](README.zh-CN.md)**

---

## Highlights

- **Side-by-side grid**: rows = translation keys, columns = sibling language files (`en_us.json`, `zh_cn.json`, `ja_jp.json`, …). Click any cell to edit; empty cells are marked as missing.
- **Registered as an editor (Open With…)**: opening a language file always keeps VS Code's default JSON editor — nothing is intercepted. Pick the GUI explicitly whenever you want it.
- **Language chips** toggle columns and show per-language completion (e.g. `en_us 42/50`).
- **Detail panel** (click a row): compares the key across all languages with multi-line inputs; the **key itself is editable right there** (rename syncs to every language file, `Enter` commits / `Esc` reverts). The panel can be **docked at the bottom, left or right, or maximized fullscreen** (drag the divider to resize; choice is remembered).
- **Row navigation**: inside the detail panel use `Ctrl+↑`/`Ctrl+↓` (or the ↑/↓ buttons) to jump between the previous/next entries of the current list; `Ctrl+Shift+G` jumps straight to a specific translation key.
- **Right-click a table row** opens VS Code's **native context menu** (copy key / translation / entry, delete) — focus and caret inside text fields are preserved after the menu closes.
- **Add / delete / rename keys** across all files at once — undoable. “＋ Add” opens the detail panel as a draft: type the new key and press `Enter` (key/value editing continues in the same place, in all languages).
- **Undo / Redo**: toolbar buttons and `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` (100-step in-session stack; every edit auto-saves).
- **Filter** (keys or any translation text), **only-missing** toggle, column sorting (click the key header for alphabetical order, click a language header to sort by its translations; click again to reverse).
- **Resizable columns**: drag a column header edge to change its width; double-click it to auto-fit that column to its longest visible text (wide grids scroll horizontally).
- **Code completion**: key fields suggest existing keys (annotated with missing languages) and common Minecraft key prefixes; value fields suggest `%s` / `%d` / `%1$s` placeholders used by the other languages for that key.
- **Follows VS Code editor settings & theme**: editing text uses `editor.fontSize` / `editor.fontFamily` (live, row height adapts); dedicated overrides (`minecraftLanguageEditor.fontSize` / `fontFamily`) apply when set, otherwise it follows the code editor. Colors come from the active theme's CSS variables (editor, selection, completion popup, …); keys and `%s` placeholders get code-token coloring that follows theme switches. UI text follows VS Code's display language (中文 / English) with compact labels.
- **Placeholder check**: a ⚠ warning is shown when `%s` / `%d` / `%1$s` tokens disagree across languages for one key.
- **Empty / broken file friendly**: empty or blank language files are treated as editable files with no translations yet; files that fail to parse or cannot even be read are isolated — reported as a banner, **never rewritten**, and they **never block** opening/editing the other files in the folder.
- **Format preservation**: on write, each file keeps its original key order, indentation (spaces or tabs), trailing newline and BOM; new keys are appended at the end (diff-friendly).

## How to open the GUI (opt-in)

1. Explorer **right-click** a `.json` file → *Minecraft Language File: Open with GUI Editor*.
2. **Open With… / Reopen With…** → *Minecraft 语言文件编辑器 (GUI)*.
3. **Command Palette** → *Minecraft Language File: Open with GUI Editor* (activates the file in the active editor, if any).

To make the GUI the default for certain files, add an entry under `workbench.editorAssociations`:

```json
"workbench.editorAssociations": {
  "**/lang/en_us.json": "minecraftLanguageEditor.gridEditor",
  "**/lang/zh_cn.json": "minecraftLanguageEditor.gridEditor"
}
```

> Language files must use the Minecraft-style lowercase `xx[_xx].json` name and contain a **flat string map** (`{ "key": "translation" }`) — the standard language-file format.

## Keyboard shortcuts

| Action | Keys |
| --- | --- |
| Undo / Redo | `Ctrl+Z` / `Ctrl+Y` (macOS: `Cmd`) — while typing in a text field this undoes/redoes only that field's own edits (silently does nothing when there is nothing to undo there); table-level undo applies when focus is outside a field |
| Focus search box | `/` |
| Close detail / cancel editing | `Esc` |
| Previous / next entry (detail open) | `Ctrl+↑` / `Ctrl+↓` |
| Add a new key (like Insert Line Below/Above) | `Ctrl+Enter` / `Ctrl+Shift+Enter` |
| Cell edit (double-click) | `Enter` commits; `Shift+Enter` newline; completion via `↑↓ Enter`/`Tab`/`Esc` |
| Multi-select rows | checkboxes, `Ctrl/⌘`+click, or `Shift`+click range |
| Delete selected rows | toolbar 🗑 (or `Delete` with rows selected) |
| Rename key (detail panel) | edit the key field, `Enter` commits, `Esc` reverts |

The *new-key* shortcut only reacts while focus is in the grid or the key field — never while typing inside a translation editor.

## Settings (`minecraftLanguageEditor.*`)

| Setting | Default | Description |
| --- | --- | --- |
| `confirmDelete` | `true` | Confirm before deleting translations; the dialog's "don't ask again" box turns this off (re-enable here) |
| `detailDock` | `bottom` | Default position of the detail panel (`bottom`/`left`/`right`/`full`); docking in the GUI writes here automatically, so it survives restarts and is editable in settings |
| `fontSize` | `null` | Font size (px) for all editing text; `null` follows `editor.fontSize`, a value overrides it |
| `fontFamily` | `null` | Font family for all editing text; `null` follows `editor.fontFamily` |
| `undoLimit` | `100` | Undo history steps (in-session) |
| `indentSize` | `2` | Spaces used on write when the original indentation cannot be detected (`0` = single line) |

## How it works

The folder of the opened file is treated as one "language set": every `xx_xx.json` becomes a column. The extension host owns the merged model and the undo stack; the webview is just a view. Every edit is written through VS Code's text-editing API and auto-saved, so hot-exit and on-disk conflict handling stay native. Undo/redo restores **full snapshots of the affected files**, so cross-file operations revert exactly.

## Known limitations

- Undo history lives in the current session only (edits are auto-saved to disk, nothing is lost on restart; tabs are restored natively and rebuilt from disk).
- Simultaneous edits by other tools are last-writer-wins; external changes are detected and trigger a reload.
- Old `.lang` (properties) files are out of scope — JSON only.

## For developers

- Pure logic: `src/detection.js`, `src/langSet.js` (standalone unit-testable).
- Model / persistence / undo: `src/model.js`; custom editor wiring: `src/panel.js`.
- Webview GUI: `media/editor.{html,css,js}`.
- Tests: `npm test` (mocha in the extension host; `npx mocha test/extension.test.js` for a fast pure-logic run).

## License

MIT
