import { RgdTable, RgdValue, RgdDataType, RgdEntry, LocaleEntry } from '../bundled/rgd-tools/dist/types';
import { resolveAttribPath, tryResolveValuePath, ResolvedPathInfo } from './pathResolver';
import { localeGet } from './localeLoader';

export interface RgdNode {
  key: string;
  hash: number;
  type: RgdDataType;
  value: RgdValue;
  ref?: string;
  children?: RgdNode[];
  resolvedPath?: string;
  resolvedExists?: boolean;
  localeId?: string;
  localeText?: string;
  localeFile?: string;
  localeLine?: number;
}

export function rgdToTree(
  table: RgdTable,
  attribRoot?: string,
  localeMap?: Map<string, LocaleEntry>
): RgdNode[] {
  const nodes: RgdNode[] = [];
  for (const entry of table.entries) {
    const node: RgdNode = {
      key: entry.name || `0x${entry.hash.toString(16)}`,
      hash: entry.hash,
      type: entry.type,
      value: entry.value,
      ref: entry.reference,
    };

    if (entry.type === RgdDataType.Table || entry.type === RgdDataType.TableInt) {
      node.children = rgdToTree(entry.value as RgdTable, attribRoot, localeMap);
      node.value = '';
    }

    if (attribRoot) {
      let resolved: ResolvedPathInfo | undefined;
      if (node.ref) {
        resolved = resolveAttribPath(node.ref, attribRoot);
      } else {
        resolved = tryResolveValuePath(node.value, attribRoot);
      }
      if (resolved) {
        node.resolvedPath = resolved.path;
        node.resolvedExists = resolved.exists;
      }
    }

    if (typeof node.value === 'string' && /^\$\d+$/.test(node.value)) {
      node.localeId = node.value;
      if (localeMap) {
        const entry = localeGet(localeMap, node.value);
        if (entry) {
          node.localeText = entry.text;
          node.localeFile = entry.file;
          node.localeLine = entry.line;
        }
      }
    }

    nodes.push(node);
  }
  return nodes;
}

export function treeToRgd(nodes: RgdNode[]): RgdTable {
  const entries: RgdEntry[] = [];
  for (const node of nodes) {
    const entry: RgdEntry = {
      hash: node.hash,
      name: node.key,
      type: node.type,
      value: node.value,
    };
    if (node.ref) entry.reference = node.ref;
    if (node.children) {
      entry.value = treeToRgd(node.children);
    }
    entries.push(entry);
  }
  return { entries };
}
