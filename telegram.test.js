import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramSender } from './telegram.js';

const okResponse = () => ({ json: async () => ({ ok: true }) });

test('대화 ID마다 한 번씩 보낸다', async () => {
  const calls = [];
  const send = createTelegramSender({
    token: '123:abc',
    chatIds: ['111', '@channel'],
    fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return okResponse(); },
  });
  await send('안녕');

  assert.deepEqual(calls.map(call => call.body.chat_id), ['111', '@channel']);
  assert.equal(calls[0].url, 'https://api.telegram.org/bot123:abc/sendMessage');
  assert.equal(calls[0].body.parse_mode, 'HTML');
  assert.equal(calls[0].body.text, '안녕');
});

test('꺼져 있으면 아무것도 하지 않는다', async () => {
  let called = false;
  const send = createTelegramSender({
    enabled: false, token: '123:abc', chatIds: ['111'],
    fetchImpl: async () => { called = true; return okResponse(); },
  });
  await send('안녕');
  assert.equal(called, false);
});

test('토큰이나 대화 ID가 없으면 경고만 남긴다', async () => {
  const warnings = [];
  const send = createTelegramSender({
    token: '', chatIds: [], warn: text => warnings.push(text),
    fetchImpl: async () => { throw new Error('불려서는 안 된다'); },
  });
  await send('안녕');
  assert.deepEqual(warnings, ['[텔레그램] 봇 토큰/대화 ID 없음 (설정 화면 또는 .env 확인)']);
});

test('전송이 거절되거나 통신이 끊겨도 예외를 던지지 않는다', async () => {
  const warnings = [];
  const responses = [
    async () => ({ json: async () => ({ ok: false, description: 'chat not found' }) }),
    async () => { throw new Error('ECONNRESET'); },
  ];
  const send = createTelegramSender({
    token: '123:abc',
    chatIds: ['111', '222'],
    warn: text => warnings.push(text),
    fetchImpl: () => responses.shift()(),
  });
  await send('안녕');

  assert.deepEqual(warnings, [
    '[텔레그램] 전송 실패 chat=111: chat not found',
    '[텔레그램] 오류: ECONNRESET',
  ]);
});
