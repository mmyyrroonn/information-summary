import assert from 'node:assert/strict';
import test from 'node:test';
import type { SourceList } from '../src/types.ts';
import { buildSourcePeople, resolveSourceListSelection } from '../src/pages/sourceListTweetFilters.ts';

const baseList: SourceList = {
  id: 'list-1',
  name: 'AI Builders',
  description: null,
  enabled: true,
  scheduleCron: '*/15 * * * *',
  batchSize: 20,
  sourceCooldownHours: 6,
  createdAt: '2026-05-12T00:00:00.000Z',
  updatedAt: '2026-05-12T00:00:00.000Z'
};

test('builds selectable people from twitter sources in the selected source list', () => {
  const list: SourceList = {
    ...baseList,
    sources: [
      {
        id: 'source-1',
        listId: 'list-1',
        platform: 'TWITTER',
        identifier: 'alice',
        displayName: 'Alice Chen',
        tags: ['ai'],
        enabled: true,
        subscriptionId: 'sub-1',
        createdAt: '2026-05-12T00:00:00.000Z',
        updatedAt: '2026-05-12T00:00:00.000Z'
      },
      {
        id: 'source-2',
        listId: 'list-1',
        platform: 'YOUTUBE',
        identifier: 'yt-channel',
        displayName: 'Video Feed',
        tags: [],
        enabled: true,
        createdAt: '2026-05-12T00:00:00.000Z',
        updatedAt: '2026-05-12T00:00:00.000Z'
      },
      {
        id: 'source-3',
        listId: 'list-1',
        platform: 'TWITTER',
        identifier: '@bob',
        displayName: null,
        tags: ['infra'],
        enabled: false,
        createdAt: '2026-05-12T00:00:00.000Z',
        updatedAt: '2026-05-12T00:00:00.000Z'
      }
    ]
  };

  const people = buildSourcePeople(list);

  assert.equal(people.length, 2);
  assert.deepEqual(
    people.map((person) => ({
      id: person.id,
      handle: person.handle,
      label: person.label,
      subtitle: person.subtitle,
      enabled: person.enabled
    })),
    [
      {
        id: 'source-1',
        handle: '@alice',
        label: 'Alice Chen',
        subtitle: '@alice · ai',
        enabled: true
      },
      {
        id: 'source-3',
        handle: '@bob',
        label: '@bob',
        subtitle: '停用 · infra',
        enabled: false
      }
    ]
  );
});

test('keeps the selected source list when it still exists and otherwise chooses the first enabled list', () => {
  const lists: SourceList[] = [
    { ...baseList, id: 'disabled', enabled: false, name: 'Disabled' },
    { ...baseList, id: 'enabled', enabled: true, name: 'Enabled' }
  ];

  assert.equal(resolveSourceListSelection(lists, 'enabled'), 'enabled');
  assert.equal(resolveSourceListSelection(lists, 'missing'), 'enabled');
  assert.equal(resolveSourceListSelection([{ ...baseList, id: 'only', enabled: false }], ''), 'only');
  assert.equal(resolveSourceListSelection([], 'anything'), '');
});
