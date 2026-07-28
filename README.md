# RGD Suite

> **Corsix, but for VS Code!**

Complete VS Code / Windsurf extension for Relic Game Data (`.rgd`) files used in Dawn of War and Company of Heroes modding.

Merges **RGD Editor** and **RGD CLI** into a single package with an embedded hash dictionary.

## Install

[![Latest Release](https://img.shields.io/github/v/release/CannibalToast/rgd-suite?label=latest&color=blue)](https://github.com/CannibalToast/rgd-suite/releases/latest)

Download from the [Releases](https://github.com/CannibalToast/rgd-suite/releases/latest) page and either:

- Drag and drop the `.vsix` into the Extensions panel, or
- Run: `code --install-extension rgd-suite-latest.vsix`

## Features

### Table Editor

- Open `.rgd` files in a split-pane table editor (tree + property grid)
- Edit scalar values (float, int, bool, string) inline
- Save changes back to binary format
- Clickable `$REF` links to open referenced files

### Sidebar Tree View

- Persistent RGD tree in the Explorer sidebar
- Inline value editing via input box
- Auto-loads from the active editor

### Conversion Commands

| Command | Description |
| ------- | ----------- |
| `RGD: Convert to Text Format` | Binary → `.rgd.txt` human-readable format |
| `RGD: Convert Text to Binary` | `.rgd.txt` → binary `.rgd` |
| `RGD: Dump to Lua` | Binary → differential Lua format |
| `RGD: Compile Lua to RGD` | Lua → binary `.rgd` |
| `RGD: Batch Convert Folder to Lua` | Batch Lua dump |
| `RGD: Batch Compile Folder to RGD` | Batch compile |
| `RGD: Extract from SGA Archive` | Extract `.rgd` files from SGA archives |
| `RGD: Show File Info` | Display file metadata |

### Parity Checker

Diff a binary `.rgd` against its Lua source to catch stale builds or manual edits — single file or entire folder.

| Command | Description |
| ------- | ----------- |
| `RGD: Check Parity (RGD ↔ Lua)` | Compare one `.rgd` / `.lua` pair |
| `RGD: Batch Parity Check (Folder)` | Recursively check all pairs in a folder |

Results appear in **Output → RGD Parity Checker** with per-key `[PASS]` / `[FAIL]` / `[SKIP]` lines.

### Git Table Diff

Compare a working-tree `.rgd` against a git revision at the **key/value table level** (not a binary hex dump):

| Command | Description |
| ------- | ----------- |
| `RGD Suite: Show Git Table Diff` | Open the table editor ready for git compare |
| Table editor toolbar **Git Diff** | Diff vs `HEAD`: highlighted tree rows + change list |
| CLI `table-diff file.rgd [--ref HEAD]` | Machine-readable key-level diff (`--format json`) |

Rows are colored added / removed / changed; click a list entry to jump to that key in the tree.

### Creature comforts (explorer right-click)

The **RGD Suite** submenu organizes everyday modding workflows (inspired by Corsix Mod Studio):

| Area | Commands |
| ---- | -------- |
| Open | Table / text editor, open counterpart, RGD+Lua side-by-side, clone/copy as… |
| Navigate… | Open parent `Reference()`, find reverse references, search keys, find by name, reveal attrib root |
| Copy… | Attrib path, `data/attrib/…`, `Reference()` snippet, hash, file info JSON, names |
| Tools… | Rename pair **+ rewrite references** (optional recompile), compare tables, strip BOM, new RGD, digest, PowerShell CLI |
| Convert | Selection → Lua/RGD/text, dump & open, compile & open |
| Folder | Batch convert, batch validate/parity, key search, find files, new RGD |

### CLI Commands (native, no subprocess)

| Command | Description |
| ------- | ----------- |
| `RGD: Convert Lua to RGD (CLI)` | `rgd.fromLua` |
| `RGD: Convert RGD to Lua (CLI)` | `rgd.toLua` |
| `RGD: Show RGD Info (CLI)` | `rgd.info` |
| `RGD: Validate File (CLI)` | `rgd.validate` |

### Language Support

- Syntax highlighting for `.rgd.txt` files
- Clickable document links for file paths, `$ID` locale strings, and icon names

## Configuration

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `rgdEditor.dictionaryPaths` | `[]` | Additional hash dictionary files |
| `rgdEditor.preferredLanguage` | `Chinese` | Language for UCS string resolution |
| `rgdEditor.autoConvertOnSave` | `true` | Auto-save `.rgd.txt` back to binary |
| `rgdEditor.resolveLocaleStrings` | `true` | Resolve `$ID` locale strings when opening RGDs |
| `rgdEditor.retainWebviewContext` | `true` | Keep table editor alive when hidden |
| `rgdSuite.attribPath` | `""` | Override attrib root path |
| `rgdSuite.vfsCacheSize` | `50` | Parsed RGD cache size for rgd:// text |
| `rgdSuite.treeCacheSize` | `30` | Parsed RGD cache for tree sidebar |
| `rgdSuite.parityWorkers` | `0` | Worker threads for batch parity (`0` = auto) |
| `rgdSuite.batchWorkers` | `0` | Worker threads for batch convert/validate |

## Building from Source

```powershell
cd rgd-suite
npm install
npm run build-all   # compiles + packages rgd-suite-<version>.vsix
```

- `npm run build` — compile only (`out/extension.js`)
- `npm run watch` — incremental rebuild during development
- `npm run package` — package only (reads version from `package.json`)

### Devin Desktop hook (aislop)

This repo defines a Devin **Stop** hook in `.devin/hooks.v1.json` that runs `aislop scan` (scan only — never auto-fix) and injects a short findings summary into agent context. Full output is written to `.devin/aislop-last-scan.txt` (gitignored).

Requires global `aislop` (`npm i -g aislop`). In Devin, run `/hooks` to confirm the hook is loaded.

## Credits

The hash dictionary (`RGD_DIC.TXT`) and the foundational RGD ↔ Lua conversion techniques used in this extension are derived from **[Corsix's Mod Studio](http://modstudio.corsix.org)**
Without his original research into the Relic binary format and his hash dictionary, none of this would have been possible.

## License

MIT
