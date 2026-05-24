import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { parseRgd } from "../bundled/rgd-tools/dist/reader";
import {
  rgdToLuaDifferential,
  luaToRgdResolved,
  parseLuaToTable,
} from "../bundled/rgd-tools/dist/luaFormat";
import {
  findAttribBase,
  makeLuaFileLoader,
  makeLuaParentLoader,
  makeRgdParentLoader,
  countEntries,
  collectValidateFilesAsync,
} from "./attribUtils";
import { defaultWorkerCount, scheduleBatched } from "./taskScheduling";
import { writeRgdFile } from "../bundled/rgd-tools/dist/writer";
import { DictionaryManager } from "./dictionaryManager";
import { getErrorMessage } from "./errorUtils";
import {
  ValidationWorkerPool,
  ValidationWorkerResult,
} from "./validationPool";
import {
  validateEncoding,
  validateFilePath,
  validateLuaReferences,
  validateRgdReferences,
  stripUtf8Bom,
  stripUtf8BomFromFile,
  ValidationIssue,
  ValidationFix,
} from "./validators";

function getAttribPath(filePath: string): string {
  const cfg = vscode.workspace.getConfiguration();
  const configured = cfg.get<string>("rgdSuite.attribPath");
  if (configured && configured.trim().length > 0) {
    return path.isAbsolute(configured)
      ? configured
      : path.join(path.dirname(filePath), configured);
  }
  const root =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
    path.dirname(filePath);
  return path.join(root, "data", "attrib");
}

export function registerCliCommands(context: vscode.ExtensionContext) {
  const dict = () => DictionaryManager.getInstance().getDictionary(context);

  const formatIssues = (issues: ValidationIssue[]): string =>
    issues.length === 0
      ? "No validation issues found"
      : issues
          .slice(0, 12)
          .map(
            (i) =>
              `${i.kind}${i.key ? ` at ${i.key}` : ""}: ${i.path} — ${i.details}`,
          )
          .join("\n") +
        (issues.length > 12 ? `\n... and ${issues.length - 12} more` : "");

  const stripBom = (file: string, buffer = fs.readFileSync(file)): {
    buffer: Buffer;
    fix?: ValidationFix;
  } => {
    const result = stripUtf8BomFromFile(file, buffer);
    return { buffer: result.buffer, fix: result.fix };
  };

  // rgd.fromLua — compile Lua to RGD using native library
  context.subscriptions.push(
    vscode.commands.registerCommand("rgd.fromLua", async (uri?: vscode.Uri) => {
      try {
        const file =
          uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!file) {
          vscode.window.showErrorMessage("No Lua file selected");
          return;
        }

        const { buffer, fix } = stripBom(file);
        const luaCode = buffer.toString("utf8");
        const d = dict();
        const attribBase = findAttribBase(file) ?? getAttribPath(file);
        const rgdParentLoader = makeRgdParentLoader(attribBase, d);
        const { gameData, version } = await luaToRgdResolved(
          luaCode,
          d,
          rgdParentLoader,
        );
        const out = file.replace(/\.lua$/i, ".rgd");
        if (fs.existsSync(out)) {
          const choice = await vscode.window.showWarningMessage(
            `${path.basename(out)} already exists. Overwrite?`,
            "Yes",
            "No",
          );
          if (choice !== "Yes") return;
        }
        writeRgdFile(out, gameData, d, version);
        vscode.window.showInformationMessage(
          `RGD generated: ${path.basename(out)}${fix ? " (UTF-8 BOM removed)" : ""}`,
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `from-lua failed: ${getErrorMessage(e)}`,
        );
      }
    }),
  );

  // rgd.toLua — dump RGD to Lua using native library
  context.subscriptions.push(
    vscode.commands.registerCommand("rgd.toLua", async (uri?: vscode.Uri) => {
      try {
        const file =
          uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!file) {
          vscode.window.showErrorMessage("No RGD file selected");
          return;
        }

        const d = dict();
        const attribBase = findAttribBase(file);
        const rgd = parseRgd(fs.readFileSync(file), d);
        const parentLoader = makeLuaParentLoader(attribBase, d);
        const luaCode = await rgdToLuaDifferential(rgd, parentLoader);
        const out = file.replace(/\.rgd$/i, ".lua");
        fs.writeFileSync(out, luaCode, "utf8");
        const doc = await vscode.workspace.openTextDocument(out);
        await vscode.window.showTextDocument(doc);
        vscode.window.showInformationMessage(
          `Lua generated: ${path.basename(out)}`,
        );
      } catch (e) {
        vscode.window.showErrorMessage(`to-lua failed: ${getErrorMessage(e)}`);
      }
    }),
  );

  // rgd.info — show RGD info using native library
  context.subscriptions.push(
    vscode.commands.registerCommand("rgd.info", async (uri?: vscode.Uri) => {
      try {
        const file =
          uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!file) {
          vscode.window.showErrorMessage("No RGD file selected");
          return;
        }

        const d = dict();
        const buffer = fs.readFileSync(file);
        const rgd = parseRgd(buffer, d);
        const { totalEntries, tableCount } = countEntries(rgd.gameData.entries);

        const info = [
          `File: ${path.basename(file)}`,
          `Size: ${buffer.length} bytes`,
          `Version: ${rgd.header.version}`,
          `Chunks: ${rgd.chunks.length}`,
          `Total Entries: ${totalEntries}`,
          `Tables: ${tableCount}`,
        ];
        if (rgd.gameData.reference)
          info.push(`Reference: ${rgd.gameData.reference}`);

        vscode.window.showInformationMessage(info.join(" | "));
      } catch (e) {
        vscode.window.showErrorMessage(`info failed: ${getErrorMessage(e)}`);
      }
    }),
  );

  // rgd.validate — validate RGD file using native library
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rgd.validate",
      async (uri?: vscode.Uri) => {
        try {
          const file =
            uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
          if (!file) {
            vscode.window.showErrorMessage("No RGD file selected");
            return;
          }

          const d = dict();
          parseRgd(fs.readFileSync(file), d);
          vscode.window.showInformationMessage(
            `✓ Valid RGD file: ${path.basename(file)}`,
          );
        } catch (e) {
          vscode.window.showErrorMessage(
            `Validation failed: ${getErrorMessage(e)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rgd.validatePath",
      async (uri?: vscode.Uri) => {
        const file =
          uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!file) {
          vscode.window.showErrorMessage("No file selected");
          return;
        }
        const attribBase = findAttribBase(file);
        const refPath = attribBase ? path.relative(attribBase, file) : file;
        const issues = validateFilePath(refPath);
        if (issues.length === 0) {
          vscode.window.showInformationMessage(
            `Path OK: ${path.basename(file)}`,
          );
        } else {
          vscode.window.showWarningMessage(formatIssues(issues));
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rgd.validateEncoding",
      async (uri?: vscode.Uri) => {
        const file =
          uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!file) {
          vscode.window.showErrorMessage("No file selected");
          return;
        }
        try {
          const { buffer, fix } = stripBom(file);
          const result = validateEncoding(buffer, file);
          if (result.issues.length === 0) {
            vscode.window.showInformationMessage(
              `Encoding OK: ${path.basename(file)} (${result.encoding})${fix ? " — UTF-8 BOM removed" : ""}`,
            );
          } else {
            vscode.window.showWarningMessage(formatIssues(result.issues));
          }
        } catch (e) {
          vscode.window.showErrorMessage(
            `Encoding validation failed: ${getErrorMessage(e)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rgd.validateReferences",
      async (uri?: vscode.Uri) => {
        const file =
          uri?.fsPath || vscode.window.activeTextEditor?.document.uri.fsPath;
        if (!file) {
          vscode.window.showErrorMessage("No file selected");
          return;
        }
        try {
          const d = dict();
          const attribBase = findAttribBase(file);
          let issues: ValidationIssue[] = [];
          if (file.endsWith(".rgd")) {
            const rgd = parseRgd(fs.readFileSync(file), d);
            issues = validateRgdReferences(rgd.gameData, attribBase);
          } else if (file.endsWith(".lua")) {
            const { buffer } = stripBom(file);
            const lua = stripUtf8Bom(buffer.toString("utf8"));
            const luaTable = parseLuaToTable(lua, makeLuaFileLoader(attribBase, d));
            issues = validateLuaReferences(luaTable, attribBase);
          } else {
            vscode.window.showErrorMessage("Select a .rgd or .lua file");
            return;
          }
          if (issues.length === 0) {
            vscode.window.showInformationMessage(
              `References OK: ${path.basename(file)}`,
            );
          } else {
            vscode.window.showWarningMessage(formatIssues(issues));
          }
        } catch (e) {
          vscode.window.showErrorMessage(
            `Reference validation failed: ${getErrorMessage(e)}`,
          );
        }
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "rgd.batchValidate",
      async (uri?: vscode.Uri) => {
        let folder = uri?.fsPath;
        if (!folder || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
          const sel = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: "Select Folder to Validate",
          });
          if (!sel?.length) return;
          folder = sel[0].fsPath;
        }
        if (!folder) return;

        try {
          const attribBase = findAttribBase(folder);
          const out = vscode.window.createOutputChannel("RGD Validation");
          out.clear();
          out.show(true);
          out.appendLine(`Batch validation started: ${folder}`);
          out.appendLine(`Attrib root: ${attribBase || "(not resolved)"}`);

          const extensionPath = context.extensionPath;
          const workerScript = path.join(
            extensionPath,
            "workers",
            "validation-worker.js",
          );
          const distPath = path.join(extensionPath, "bundled", "rgd-tools", "dist");
          const cfg = vscode.workspace.getConfiguration("rgdEditor");
          const userDicts = (cfg.get<string[]>("dictionaryPaths") || []).filter((p) =>
            fs.existsSync(p),
          );
          const bundledDict = path.join(extensionPath, "dictionaries", "RGD_DIC.TXT");
          const allDictPaths = fs.existsSync(bundledDict)
            ? [bundledDict, ...userDicts]
            : userDicts;
          const canUseWorkers = fs.existsSync(workerScript);
          const configuredCount = vscode.workspace
            .getConfiguration("rgdSuite")
            .get<number>("batchWorkers", 0);
          const workerCount = canUseWorkers
            ? defaultWorkerCount(configuredCount)
            : 0;
          out.appendLine(
            `Workers: ${workerCount > 0 ? workerCount.toString() : "sequential fallback"}`,
          );

          const issues: ValidationIssue[] = [];
          const fixes: ValidationFix[] = [];
          const errors: Array<{ file: string; error: string }> = [];
          const files = await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "RGD Batch Validate",
              cancellable: true,
            },
            async (progress, token) => {
              progress.report({ message: "Finding files..." });
              const discovered = await collectValidateFilesAsync(folder);
              out.appendLine(`Files discovered: ${discovered.length}`);

              let logIssuesAt = 0;
              const appendResult = (result: ValidationWorkerResult) => {
                const file = result.filePath;
                const rel = path.relative(folder, file);
                if (result.fixes.length > 0) {
                  fixes.push(...result.fixes);
                }
                if (result.issues.length > 0) {
                  issues.push(...result.issues);
                }
                const now = Date.now();
                if (
                  result.fixes.length > 0 ||
                  result.issues.length > 0 ||
                  now - logIssuesAt > 500
                ) {
                  logIssuesAt = now;
                  if (result.fixes.length > 0) {
                    for (const fix of result.fixes) {
                      out.appendLine(`[FIXED] ${rel}: ${fix.details}`);
                    }
                  }
                  if (result.issues.length > 0) {
                    out.appendLine(`[ISSUES] ${rel}: ${result.issues.length}`);
                    for (const issue of result.issues.slice(0, 5)) {
                      out.appendLine(
                        `  - ${issue.kind}${issue.key ? ` at ${issue.key}` : ""}: ${issue.path} — ${issue.details}`,
                      );
                    }
                    if (result.issues.length > 5) {
                      out.appendLine(
                        `  ... and ${result.issues.length - 5} more`,
                      );
                    }
                  }
                }
              };

              const validateInProcess = (file: string): ValidationWorkerResult => {
                const d = dict();
                const lower = file.toLowerCase();
                const fileIssues: ValidationIssue[] = [];
                const fileFixes: ValidationFix[] = [];
                let textBuffer: Buffer | null = null;
                if (lower.endsWith(".lua") || lower.endsWith(".rgd.txt")) {
                  const { buffer, fix } = stripBom(file);
                  textBuffer = buffer;
                  if (fix) fileFixes.push(fix);
                  fileIssues.push(...validateEncoding(buffer, file).issues);
                }
                if (lower.endsWith(".lua")) {
                  const lua = stripUtf8Bom(
                    (textBuffer ?? fs.readFileSync(file)).toString("utf8"),
                  );
                  const table = parseLuaToTable(lua, makeLuaFileLoader(attribBase, d));
                  fileIssues.push(...validateLuaReferences(table, attribBase));
                } else if (lower.endsWith(".rgd")) {
                  const rgd = parseRgd(fs.readFileSync(file), d);
                  fileIssues.push(...validateRgdReferences(rgd.gameData, attribBase));
                }
                return { filePath: file, issues: fileIssues, fixes: fileFixes };
              };

              let completed = 0;
              let lastProgressMs = Date.now();
              const reportEvery = Math.max(1, Math.floor(discovered.length / 200));
              const bumpProgress = (file: string) => {
                completed++;
                const now = Date.now();
                if (
                  completed % reportEvery === 0 ||
                  completed === discovered.length ||
                  now - lastProgressMs > 500
                ) {
                  lastProgressMs = now;
                  progress.report({
                    message: `${completed}/${discovered.length}: ${path.relative(folder, file)}`,
                    increment:
                      discovered.length > 0 ? (100 * reportEvery) / discovered.length : 0,
                  });
                }
              };

              let pool: ValidationWorkerPool | null = null;
              let logTimer: ReturnType<typeof setInterval> | null = null;
              const batchStartTime = Date.now();
              try {
                if (workerCount > 0) {
                  pool = new ValidationWorkerPool(
                    workerCount,
                    workerScript,
                    distPath,
                    allDictPaths,
                  );
                  pool.start();
                  const activePool = pool;
                  token.onCancellationRequested(() => {
                    if (pool) pool.cancel();
                    out.appendLine("Batch validation cancelled.");
                  });

                  logTimer = setInterval(() => {
                    if (completed === 0) return;
                    const secs = (Date.now() - batchStartTime) / 1000;
                    const rate = secs > 0 ? Math.round(completed / secs) : 0;
                    out.appendLine(
                      `  → [${completed}/${discovered.length}] ${issues.length} issue(s) | ${rate} files/sec`,
                    );
                  }, 1000);

                  await scheduleBatched(discovered, workerCount, async (file) => {
                    try {
                      const result = await activePool.validate(file, attribBase);
                      appendResult(result);
                    } catch (fileError) {
                      if (!token.isCancellationRequested) {
                        const error = getErrorMessage(fileError);
                        errors.push({ file, error });
                        out.appendLine(
                          `[ERROR] ${path.relative(folder, file)}: ${error}`,
                        );
                      }
                    } finally {
                      bumpProgress(file);
                    }
                  });
                } else {
                  for (let i = 0; i < discovered.length; i++) {
                    if (token.isCancellationRequested) {
                      out.appendLine("Batch validation cancelled.");
                      break;
                    }
                    const file = discovered[i];
                    const rel = path.relative(folder, file);
                    try {
                      appendResult(validateInProcess(file));
                    } catch (fileError) {
                      const error = getErrorMessage(fileError);
                      errors.push({ file, error });
                      out.appendLine(`[ERROR] ${rel}: ${error}`);
                    }
                    bumpProgress(file);
                    if (i % 25 === 0) {
                      await new Promise<void>((resolve) => setImmediate(resolve));
                    }
                  }
                }
              } finally {
                if (logTimer) clearInterval(logTimer);
                if (pool) pool.dispose();
              }
              return discovered;
            },
          );

          const msg = `${files.length} file(s) checked | ${issues.length} validation issue(s) | ${fixes.length} fix(es) | ${errors.length} error(s)`;
          out.appendLine(msg);
          if (issues.length === 0 && errors.length === 0) {
            vscode.window.showInformationMessage(`Batch validation OK: ${msg}`);
          } else {
            vscode.window.showWarningMessage(
              `Batch validation found issues: ${msg} — see Output > RGD Validation`,
            );
          }
        } catch (e) {
          vscode.window.showErrorMessage(
            `Batch validation failed: ${getErrorMessage(e)}`,
          );
        }
      },
    ),
  );
}
