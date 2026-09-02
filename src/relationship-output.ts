import type {
  DirectRelationshipGroup,
  Edge,
  EdgeKind,
  Node,
  RelationshipDirection,
} from './types';
import { formatNodeLocation } from './source-location';

export interface RelationshipSite {
  kind: EdgeKind;
  filePath: string;
  line?: number;
  column?: number;
  provenance?: Edge['provenance'];
  metadata?: Record<string, unknown>;
}

export interface RelatedSymbolRelationships {
  node: Node;
  sites: RelationshipSite[];
}

export interface FormattedRelationshipSites {
  lines: string[];
  omitted: number;
}

function siteKey(site: RelationshipSite): string {
  const synthesizedBy = typeof site.metadata?.synthesizedBy === 'string'
    ? site.metadata.synthesizedBy
    : '';
  const registeredAt = typeof site.metadata?.registeredAt === 'string'
    ? site.metadata.registeredAt
    : '';
  return [
    site.kind,
    site.filePath,
    site.line ?? '',
    site.column ?? '',
    site.provenance ?? '',
    synthesizedBy,
    registeredAt,
  ].join('\u0000');
}

/** Merge direct groups from one or more declaration/definition endpoints. */
export function mergeDirectRelationshipGroups(
  merged: Map<string, RelatedSymbolRelationships>,
  root: Node,
  direction: RelationshipDirection,
  groups: DirectRelationshipGroup[],
  excludedNodeIds: ReadonlySet<string> = new Set<string>(),
): void {
  for (const group of groups) {
    if (excludedNodeIds.has(group.node.id)) continue;
    let entry = merged.get(group.node.id);
    if (!entry) {
      entry = { node: group.node, sites: [] };
      merged.set(group.node.id, entry);
    }
    const knownSites = new Set(entry.sites.map(siteKey));
    const sourceFilePath = direction === 'incoming' ? group.node.filePath : root.filePath;
    for (const edge of group.edges) {
      const site: RelationshipSite = {
        kind: edge.kind,
        filePath: sourceFilePath,
        line: edge.line,
        column: edge.column,
        provenance: edge.provenance,
        metadata: edge.metadata,
      };
      const key = siteKey(site);
      if (knownSites.has(key)) continue;
      knownSites.add(key);
      entry.sites.push(site);
    }
  }
}

export function sortRelatedSymbolRelationships(
  entries: Iterable<RelatedSymbolRelationships>,
): RelatedSymbolRelationships[] {
  return [...entries].sort((left, right) =>
    left.node.filePath.localeCompare(right.node.filePath) ||
    left.node.startLine - right.node.startLine ||
    left.node.name.localeCompare(right.node.name) ||
    left.node.id.localeCompare(right.node.id));
}

export function formatDefinitionLocation(node: Node): string {
  return formatNodeLocation(node);
}

function siteOrder(left: RelationshipSite, right: RelationshipSite): number {
  const kindOrder: Record<EdgeKind, number> = {
    calls: 0,
    references: 1,
    imports: 2,
    contains: 3,
    exports: 4,
    extends: 5,
    implements: 6,
    type_of: 7,
    returns: 8,
    instantiates: 9,
    overrides: 10,
    decorates: 11,
    defines: 12,
  };
  return Number(left.provenance === 'heuristic') - Number(right.provenance === 'heuristic') ||
    kindOrder[left.kind] - kindOrder[right.kind] ||
    left.filePath.localeCompare(right.filePath) ||
    (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER) ||
    (left.column ?? Number.MAX_SAFE_INTEGER) - (right.column ?? Number.MAX_SAFE_INTEGER);
}

interface SiteDisplay {
  label: string;
  value: string;
}

function displaySite(site: RelationshipSite): SiteDisplay {
  const synthesizedBy = typeof site.metadata?.synthesizedBy === 'string'
    ? site.metadata.synthesizedBy
    : undefined;
  const registeredAt = typeof site.metadata?.registeredAt === 'string'
    ? site.metadata.registeredAt
    : undefined;
  const synthetic = site.provenance === 'heuristic' || synthesizedBy !== undefined;
  const location = site.line && site.line > 0 ? `${site.filePath}:${site.line}` : undefined;

  if (synthetic) {
    const suffix = synthesizedBy ? ` (${synthesizedBy})` : '';
    if (location) {
      const registration = registeredAt && registeredAt !== location
        ? `; metadata location ${registeredAt}`
        : '';
      return { label: `synthetic${suffix}`, value: `${location}${registration}` };
    }
    if (registeredAt) return { label: `synthetic${suffix}`, value: `metadata location ${registeredAt}` };
    return { label: `synthetic${suffix}`, value: 'location unavailable' };
  }

  const labels: Partial<Record<EdgeKind, string>> = {
    calls: 'call',
    references: 'reference',
    imports: 'import',
  };
  return {
    label: labels[site.kind] ?? site.kind,
    value: location ?? 'location unavailable',
  };
}

/** Format a bounded, explicitly-truncated human-readable site summary. */
export function formatRelationshipSites(
  sites: RelationshipSite[],
  maxSites: number,
): FormattedRelationshipSites {
  const ordered = [...sites].sort(siteOrder);
  const shown = ordered.slice(0, Math.max(0, maxSites));
  const grouped = new Map<string, string[]>();
  for (const site of shown) {
    const display = displaySite(site);
    const values = grouped.get(display.label) ?? [];
    if (!values.includes(display.value)) values.push(display.value);
    grouped.set(display.label, values);
  }
  const pluralLabels = new Set(['call', 'reference', 'import']);
  return {
    lines: [...grouped].map(([label, values]) => {
      const displayLabel = values.length > 1 && pluralLabels.has(label) ? `${label} sites` : label;
      return `${displayLabel}: ${values.join(', ')}`;
    }),
    omitted: Math.max(0, ordered.length - shown.length),
  };
}

/** Preserve the legacy flat fields while adding the complete relationship sites. */
export function relationshipGroupToJson(group: RelatedSymbolRelationships): Record<string, unknown> {
  const node = group.node;
  return {
    name: node.name,
    kind: node.kind,
    filePath: node.filePath,
    startLine: node.startLine,
    endLine: node.endLine,
    sites: [...group.sites].sort(siteOrder).map((site) => ({
      kind: site.kind,
      filePath: site.filePath,
      line: site.line,
      column: site.column,
      provenance: site.provenance,
      metadata: site.metadata,
    })),
  };
}
