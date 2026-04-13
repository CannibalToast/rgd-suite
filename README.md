# RGD Suite

Complete VS Code extension for Relic Game Data (`.rgd`) files used in Dawn of War and Company of Heroes modding.

Merges **RGD Editor** and **RGD CLI** into a single package with an embedded hash dictionary.

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
|---------|-------------|
| `RGD: Convert to Text Format` | Binary → `.rgd.txt` human-readable format |
| `RGD: Convert Text to Binary` | `.rgd.txt` → binary `.rgd` |
| `RGD: Dump to Lua` | Binary → differential Lua format |
| `RGD: Compile Lua to RGD` | Lua → binary `.rgd` |
| `RGD: Batch Convert Folder to Lua` | Batch Lua dump |
| `RGD: Batch Compile Folder to RGD` | Batch compile |
| `RGD: Extract from SGA Archive` | Extract `.rgd` files from SGA archives |
| `RGD: Show File Info` | Display file metadata |

### CLI Commands (native, no subprocess)

| Command | Description |
|---------|-------------|
| `RGD: Convert Lua to RGD (CLI)` | `rgd.fromLua` |
| `RGD: Convert RGD to Lua (CLI)` | `rgd.toLua` |
| `RGD: Show RGD Info (CLI)` | `rgd.info` |
| `RGD: Validate File (CLI)` | `rgd.validate` |

### Language Support

- Syntax highlighting for `.rgd.txt` files
- Clickable document links for file paths, `$ID` locale strings, and icon names

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `rgdEditor.dictionaryPaths` | `[]` | Additional hash dictionary files |
| `rgdEditor.preferredLanguage` | `Chinese` | Language for UCS string resolution |
| `rgdEditor.autoConvertOnSave` | `true` | Auto-save `.rgd.txt` back to binary |
| `rgdSuite.attribPath` | `""` | Override attrib root path |

## Building

Requires the `@esbuild/win32-x64` native binary (included in `node_modules`):

```powershell
..\rgd-tools\vscode-extension\node_modules\@esbuild\win32-x64\esbuild.exe `
  .\src\extension.ts --bundle --outfile=out/extension.js `
  --external:vscode --format=cjs --platform=node
```
