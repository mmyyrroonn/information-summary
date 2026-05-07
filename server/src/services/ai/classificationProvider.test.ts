import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveClassificationChatOptions } from './classification';

test('tweet classification defaults to DeepSeek chat settings', () => {
  assert.deepEqual(resolveClassificationChatOptions(), {
    model: 'deepseek-chat',
    provider: 'deepseek'
  });
});
