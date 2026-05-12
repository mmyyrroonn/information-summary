import type { SourceList } from '../types';

export interface SourcePerson {
  id: string;
  handle: string;
  label: string;
  subtitle: string;
  enabled: boolean;
  subscriptionId?: string | null;
}

function normalizeHandle(identifier: string) {
  const normalized = identifier.replace(/^@/, '').trim().toLowerCase();
  return normalized ? `@${normalized}` : '';
}

export function buildSourcePeople(sourceList?: SourceList | null): SourcePerson[] {
  return (sourceList?.sources ?? [])
    .filter((source) => source.platform === 'TWITTER')
    .map((source) => {
      const handle = normalizeHandle(source.identifier);
      const label = source.displayName?.trim() || handle || source.identifier;
      const subtitleParts = [source.enabled ? handle : '停用', ...source.tags].filter(Boolean);
      return {
        id: source.id,
        handle,
        label,
        subtitle: subtitleParts.join(' · '),
        enabled: source.enabled,
        subscriptionId: source.subscriptionId
      };
    });
}

export function resolveSourceListSelection(sourceLists: SourceList[], currentId: string) {
  if (currentId && sourceLists.some((list) => list.id === currentId)) {
    return currentId;
  }
  return sourceLists.find((list) => list.enabled)?.id ?? sourceLists[0]?.id ?? '';
}
