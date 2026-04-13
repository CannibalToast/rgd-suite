import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { LocaleEntry } from '../bundled/rgd-tools/dist/types';

let localeOutputChannel: vscode.OutputChannel | undefined;

function getLocaleLog(): vscode.OutputChannel {
  if (!localeOutputChannel) {
    localeOutputChannel = vscode.window.createOutputChannel('RGD Locale');
  }
  return localeOutputChannel;
}

function log(message: string) {
  getLocaleLog().appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  console.log(`[RGD Locale] ${message}`);
}

export function loadLocaleMap(localeRoot: string): Map<string, LocaleEntry> {
  const map = new Map<string, LocaleEntry>();
  if (!fs.existsSync(localeRoot)) {
    log(`Root does not exist: ${localeRoot}`);
    return map;
  }

  log(`Scanning locale folder: ${localeRoot}`);
  try {
    const entries = fs.readdirSync(localeRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== '.ucs' && ext !== '.dat') continue;

      const full = path.join(localeRoot, entry.name);
      log(`  Loading file: ${entry.name}`);
      try {
        const buffer = fs.readFileSync(full);
        let content = '';

        if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
          content = buffer.toString('utf16le');
        } else if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
          content = buffer.toString('utf8', 3);
        } else {
          try {
            content = buffer.toString('utf8');
            if (content.includes('\uFFFD')) throw new Error('UTF-8 decode failed');
          } catch {
            content = buffer.toString('latin1');
          }
        }

        const count = parseUcsContent(content, map, full);
        log(`    Loaded ${count} entries from ${entry.name}`);
      } catch (e: any) {
        log(`    Error reading ${entry.name}: ${e.message}`);
      }
    }
  } catch (e: any) {
    log(`Error scanning ${localeRoot}: ${e.message}`);
  }

  return map;
}

function parseUcsContent(content: string, map: Map<string, LocaleEntry>, filePath: string): number {
  const lines = content.split(/\r?\n/);
  let matchCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    const match = line.match(/^(\d+)\s+(.+)$/);
    if (match) {
      const id = match[1];
      let text = match[2].trim();
      if (text.startsWith('"') && text.endsWith('"')) {
        text = text.substring(1, text.length - 1);
      }

      const entry: LocaleEntry = { text, file: filePath, line: i + 1 };
      map.set(`$${id}`, entry);
      map.set(id, entry);
      matchCount++;
    }
  }
  return matchCount;
}
