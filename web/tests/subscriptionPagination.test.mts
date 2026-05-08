import assert from 'node:assert/strict';
import test from 'node:test';
import { getPagedItems } from '../src/pages/subscriptionPagination.ts';

test('returns only the requested page and clamps out-of-range pages', () => {
  const items = Array.from({ length: 205 }, (_, index) => ({ id: `sub-${index + 1}` }));

  const firstPage = getPagedItems(items, 1, 100);
  assert.equal(firstPage.page, 1);
  assert.equal(firstPage.pageCount, 3);
  assert.equal(firstPage.items.length, 100);
  assert.equal(firstPage.items[0].id, 'sub-1');
  assert.equal(firstPage.items[99].id, 'sub-100');

  const lastPage = getPagedItems(items, 99, 100);
  assert.equal(lastPage.page, 3);
  assert.equal(lastPage.items.length, 5);
  assert.equal(lastPage.items[0].id, 'sub-201');
});

test('uses a single empty page for empty result sets', () => {
  const page = getPagedItems([], 4, 100);

  assert.equal(page.page, 1);
  assert.equal(page.pageCount, 1);
  assert.deepEqual(page.items, []);
});
