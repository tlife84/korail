import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(projectDir, 'launcher.html'), 'utf8');

test('런처 화면에 필수 입력과 실행 폼이 있다', () => {
  assert.match(html, /id="launcher-form"/);
  for (const name of ['date', 'from', 'to', 'adults', 'mode', 'interval']) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
});

test('런처 화면의 인라인 스크립트 문법이 유효하다', () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, '인라인 스크립트를 찾을 수 없습니다.');
  assert.doesNotThrow(() => new Function(script));
});

test('시간 입력은 지역 설정과 무관한 24시간 HH:MM 형식이다', () => {
  assert.doesNotMatch(html, /type="time"/);
  assert.match(html, /name="time"[\s\S]*?pattern="\(\?:\[01\]\[0-9\]\|2\[0-3\]\):\[0-5\]\[0-9\]"/);
  assert.match(html, /24시간 형식/);
});

test('감시 시작 전 설정 화면을 닫으면 런처 종료를 알린다', () => {
  assert.match(html, /addEventListener\('pagehide'/);
  assert.match(html, /sendBeacon\('\/api\/close'\)/);
});

test('출발역과 도착역은 사전 입력된 역 콤보박스를 사용한다', () => {
  assert.match(html, /<select name="from" required>[\s\S]*?<option value="광명" selected>광명<\/option>[\s\S]*?<option value="서대전">서대전<\/option>/);
  assert.match(html, /<select name="to" required>[\s\S]*?<option value="광명">광명<\/option>[\s\S]*?<option value="서대전" selected>서대전<\/option>/);
  assert.doesNotMatch(html, /<input name="(?:from|to)"/);
});

test('계정과 텔레그램 설정을 화면에서 입력할 수 있다', () => {
  for (const name of ['korailId', 'korailPw', 'telegramToken', 'telegramChatIds']) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.match(html, /name="korailPw" type="password"/);
  assert.match(html, /name="telegramToken" type="password"/);
  assert.match(html, /id="korail-notice"/);
  assert.match(html, /id="telegram-notice"/);
});

test('저장된 .env 값을 기본값으로 불러온다', () => {
  assert.match(html, /fetch\('\/api\/defaults'/);
  assert.match(html, /loadSavedCredentials\(\)/);
  assert.match(html, /.env에 저장된 값입니다/);
  assert.match(html, /.env 값을 지웠습니다. 이번 실행에서는 사용하지 않습니다/);
});

test('계정이 없으면 경고를, 텔레그램이 없으면 안내만 보여준다', () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.match(script, /notices\.korail = \['warn'/);
  assert.match(script, /notices\.telegram = \['info'/);
  assert.doesNotMatch(script, /notices\.telegram = \['warn'/);
});

test('실행 창구를 어댑터로 감싸 HTTP 런처와 앱 셸이 같은 화면을 쓴다', () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.match(script, /const backend = window\.korail \?\? httpBackend/);
  // 앱이 아닐 때 쓰는 HTTP 경로는 그대로 남아 있어야 한다
  assert.match(script, /fetch\('\/api\/run'/);
  assert.match(script, /backend\.loadDefaults\(\)/);
  assert.match(script, /backend\.run\(data\)/);
});

test('앱 셸에서만 실행 로그 패널로 전환한다', () => {
  assert.match(html, /<section class="card" id="run-view" hidden>/);
  assert.match(html, /id="run-log"/);
  assert.match(html, /id="stop-button"/);
  assert.match(html, /id="back-button"/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.match(script, /if \(backend\.streaming\)/);
  assert.match(script, /backend\.onLog\(appendLog\)/);
});

test('로그는 텍스트로만 넣어 화면에 태그가 실행되지 않게 한다', () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.match(script, /line\.textContent = /);
  assert.doesNotMatch(script, /innerHTML/);
});
