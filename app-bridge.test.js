/**
 * 설정 화면 · preload · Electron main 세 파일이 같은 계약을 보게 지킨다.
 *
 * 이 이음매는 Electron을 띄워야 실행되므로 평소 테스트로는 안 돌아본다.
 * 대신 이름이 어긋나는 흔한 사고(채널 오타, 노출 안 한 메서드)만 정적으로 잡는다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(fileURLToPath(import.meta.url));
const read = name => readFileSync(resolve(projectDir, name), 'utf8');

const html = read('launcher.html');
const preload = read('app/preload.cjs');
const main = read('app/main.js');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

const names = (text, pattern) => new Set([...text.matchAll(pattern)].map(match => match[1]));

const bridgeBody = preload.match(/exposeInMainWorld\('korail',\s*\{([\s\S]*?)\n\}\);/)?.[1];
const exposed = names(bridgeBody ?? '', /^\s*(\w+)\s*:/gm);

test('preload가 window.korail로 창구를 노출한다', () => {
  assert.ok(bridgeBody, 'exposeInMainWorld 호출을 찾지 못했습니다.');
  assert.ok(exposed.has('streaming'), '화면이 앱 셸인지 판단할 streaming 표시가 필요합니다.');
});

test('설정 화면이 쓰는 창구를 preload가 모두 노출한다', () => {
  const used = names(script, /backend\.(\w+)/g);
  // leave는 HTTP 런처에서 페이지를 닫을 때만 쓴다(앱은 창을 닫으면 그만).
  used.delete('leave');
  assert.ok(used.size >= 4, `backend 사용처가 너무 적습니다: ${[...used]}`);
  for (const name of used) {
    assert.ok(exposed.has(name), `preload에 ${name}가 없습니다.`);
  }
});

test('preload가 부르는 IPC 채널을 main이 모두 처리한다', () => {
  const invoked = names(preload, /request\('([\w:]+)'/g);
  const handled = names(main, /ipcMain\.handle\('([\w:]+)'/g);
  assert.ok(invoked.size >= 3, `호출 채널이 너무 적습니다: ${[...invoked]}`);
  for (const channel of invoked) {
    assert.ok(handled.has(channel), `main에 ${channel} 핸들러가 없습니다.`);
  }
});

test('main이 보내는 이벤트를 preload가 모두 구독한다', () => {
  const sent = names(main, /send\('([\w:]+)'/g);
  const subscribed = names(preload, /subscribe\('([\w:]+)'\)/g);
  assert.ok(sent.size >= 4, `보내는 이벤트가 너무 적습니다: ${[...sent]}`);
  for (const channel of sent) {
    assert.ok(subscribed.has(channel), `preload가 ${channel}을 구독하지 않습니다.`);
  }
});

test('렌더러는 노드 권한 없이 preload로만 접근한다', () => {
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
});

test('감시 중에 창을 닫아도 앱이 죽지 않는다', () => {
  assert.match(main, /win\.on\('close'/);
  assert.match(main, /event\.preventDefault\(\)/);
  assert.match(main, /new Tray\(/);
});

test('종료 전에 크롬을 정리한다', () => {
  assert.match(main, /app\.on\('before-quit'/);
  assert.match(main, /stopWatcher\(\)/);
});
