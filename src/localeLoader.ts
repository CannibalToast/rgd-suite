import * as fs from 'fs';
import * as path from 'path';
import { LocaleEntry } from '../bundled/rgd-tools/dist/types';

export function loadLocaleMap(localeRoot: string): Map<string, LocaleEntry> {
  const map = new Map<string, LocaleEntry>();
  if (!fs.existsSync(localeRoot)) {
    return map;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(localeRoot, { withFileTypes: true });
  } catch {
    return map;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (ext !== '.ucs' && ext !== '.dat') continue;

    const full = path.join(localeRoot, entry.name);
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

      parseUcsContent(content, map, full);
    } catch {
      // Skip unreadable files; caller handles empty map.
    }
  }

  return map;
}

// Keys are stored **without** a leading `$`. Callers should strip the sigil
// before lookups (see `localeGet` below). Storing a single normalized form
// roughly halves map size vs the previous "$1234" + "1234" double-insert.
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

      map.set(id, { text, file: filePath, line: i + 1 });
      matchCount++;
    }
  }
  return matchCount;
}

/**
 * Look up a locale entry tolerant of a leading `$` sigil. Call sites that
 * used to do `map.get('$1234')` or `map.get('1234')` both work through this.
 */
export function localeGet(
  map: Map<string, LocaleEntry>,
  key: string,
): LocaleEntry | undefined {
  if (!key) return undefined;
  return map.get(key.charCodeAt(0) === 36 /* '$' */ ? key.slice(1) : key);
}

/**
 * Tolerant `has` counterpart to {@link localeGet}.
 */
export function localeHas(map: Map<string, LocaleEntry>, key: string): boolean {
  if (!key) return false;
  return map.has(key.charCodeAt(0) === 36 ? key.slice(1) : key);
}
