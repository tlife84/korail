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
