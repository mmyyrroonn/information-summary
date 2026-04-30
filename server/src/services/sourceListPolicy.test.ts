import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSourceFetchDue,
  normalizeSourceIdentifier,
  selectDueSources
} from './sourceListPolicy';

test('normalizes source identifiers by platform', () => {
  assert.equal(normalizeSourceIdentifier('TWITTER', ' @OpenAI '), 'openai');
  assert.equal(normalizeSourceIdentifier('YOUTUBE', ' UC_x5XG1OV2P6uZZ5FSM9Ttw '), 'UC_x5XG1OV2P6uZZ5FSM9Ttw');
});

test('selects enabled due sources while respecting cooldown and limit', () => {
  const now = new Date('2026-04-30T00:00:00.000Z');
  const selected = selectDueSources(
    [
      { id: 'fresh', enabled: true, lastFetchedAt: null },
      { id: 'cooling', enabled: true, lastFetchedAt: new Date('2026-04-29T22:00:00.000Z') },
      { id: 'due', enabled: true, lastFetchedAt: new Date('2026-04-29T17:59:59.000Z') },
      { id: 'disabled', enabled: false, lastFetchedAt: null }
    ],
    { now, cooldownHours: 6, limit: 2 }
  );

  assert.deepEqual(
    selected.map((source) => source.id),
    ['fresh', 'due']
  );
  assert.equal(
    isSourceFetchDue({ enabled: true, lastFetchedAt: new Date('2026-04-29T22:00:00.000Z') }, { now, cooldownHours: 6 }),
    false
  );
});
