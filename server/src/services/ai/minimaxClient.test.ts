import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAnthropicRequestFromChatRequest,
  resolveMiniMaxApiMode
} from './minimaxClient';

test('resolveMiniMaxApiMode detects anthropic endpoint', () => {
  assert.equal(resolveMiniMaxApiMode('https://api.minimaxi.com/anthropic'), 'anthropic-messages');
  assert.equal(resolveMiniMaxApiMode('https://api.minimaxi.com/anthropic/'), 'anthropic-messages');
});

test('resolveMiniMaxApiMode defaults to openai endpoint', () => {
  assert.equal(resolveMiniMaxApiMode('https://api.minimax.chat/v1'), 'openai-completions');
  assert.equal(resolveMiniMaxApiMode(undefined), 'openai-completions');
});

test('buildAnthropicRequestFromChatRequest folds system/developer into system prompt', () => {
  const payload = buildAnthropicRequestFromChatRequest(
    {
      model: 'MiniMax-M2.5',
      temperature: 0.2,
      messages: [
        { role: 'system', content: 'sys rule' },
        { role: 'developer', content: 'dev rule' },
        { role: 'user', content: 'hello' }
      ]
    },
    'MiniMax-M2.5'
  );

  assert.equal(payload.model, 'MiniMax-M2.5');
  assert.equal(payload.temperature, 0.2);
  assert.equal(payload.system, 'sys rule\n\ndev rule');
  assert.equal(payload.max_tokens, 2048);
  assert.deepEqual(payload.messages, [{ role: 'user', content: 'hello' }]);
});
