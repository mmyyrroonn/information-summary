import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldKeepClusterByImportance } from './clusterVisibility';

test('keeps high-importance clusters regardless of size', () => {
  assert.equal(shouldKeepClusterByImportance({ peakImportance: 4, size: 1 }), true);
  assert.equal(shouldKeepClusterByImportance({ peakImportance: 5, size: 1 }), true);
});

test('keeps importance-3 clusters only when size >= 2', () => {
  assert.equal(shouldKeepClusterByImportance({ peakImportance: 3, size: 1 }), false);
  assert.equal(shouldKeepClusterByImportance({ peakImportance: 3, size: 2 }), true);
});

test('keeps importance-2 clusters only when size >= 3', () => {
  assert.equal(shouldKeepClusterByImportance({ peakImportance: 2, size: 2 }), false);
  assert.equal(shouldKeepClusterByImportance({ peakImportance: 2, size: 3 }), true);
});

test('drops low-importance clusters', () => {
  assert.equal(shouldKeepClusterByImportance({ peakImportance: 1, size: 20 }), false);
  assert.equal(shouldKeepClusterByImportance({ peakImportance: 0, size: 20 }), false);
});
