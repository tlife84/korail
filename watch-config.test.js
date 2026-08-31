import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, buildWatchConfig, HELP } from './watch-config.js';

const NO_CREDS = { hasKorailLogin: false, hasTelegram: false };
const FULL_CREDS = { hasKorailLogin: true, hasTelegram: true };

const build = (overrides = {}, creds = FULL_CREDS) => buildWatchConfig({
  date: '2026-09-20', from: '광명', to: '서대전', ...overrides,
}, creds);

test('--key value와 값 없는 플래그를 함께 읽는다', () => {
  assert.deepEqual(
    parseArgs(['--date', '2026-09-20', '--once', '--from', '광명', '--no-telegram']),
    { date: '2026-09-20', once: 'true', from: '광명', 'no-telegram': 'true' },
  );
});

test('인자가 아닌 값은 무시한다', () => {
  assert.deepEqual(parseArgs(['watch.js', '--adults', '2']), { adults: '2' });
});

test('필수 인자가 빠지면 무엇이 빠졌는지와 도움말을 함께 돌려준다', () => {
  const { config, error } = buildWatchConfig({ from: '광명' }, NO_CREDS);
  assert.equal(config, undefined);
  assert.ok(error.startsWith('누락된 필수 인자: --date, --to'));
  assert.ok(error.includes(HELP));
});

test('--login은 승차일 없이도 통과한다', () => {
  const { config, error } = buildWatchConfig({ login: 'true' }, NO_CREDS);
  assert.equal(error, undefined);
  assert.equal(config.loginOnly, true);
  assert.deepEqual(config.warnings, []);
});

test('날짜와 시각을 코레일 표기로 바꾸고 입력 표기도 남긴다', () => {
  const { config } = build({ time: '12:30', 'time-to': '16:00' });
  assert.equal(config.date, '20260920');
  assert.equal(config.dateLabel, '2026-09-20');
  assert.equal(config.hour, '123000');
  assert.equal(config.depFrom, 1230);
  assert.equal(config.depTo, 1600);
  assert.equal(config.timeToLabel, '16:00');
});

test('시각 상한이 없으면 depTo는 비운다', () => {
  const { config } = build();
  assert.equal(config.depFrom, 0);
  assert.equal(config.depTo, null);
  assert.equal(config.timeToLabel, null);
});

test('조회 주기는 15초, 로그인 대기는 30초 밑으로 내려가지 않는다', () => {
  const { config } = build({ interval: '3', 'login-timeout': '5' });
  assert.equal(config.interval, 15000);
  assert.equal(config.loginTimeout, 30000);
});

test('--trains는 공백을 털어 배열로 만든다', () => {
  assert.deepEqual(build({ trains: '451, 453 ,541' }).config.trains, ['451', '453', '541']);
  assert.equal(build().config.trains, null);
});

test('존재하지 않는 날짜를 거른다', () => {
  assert.match(build({ date: '2026-02-30' }).error, /실제 존재하는 YYYY-MM-DD/);
  assert.match(build({ date: '20260920' }).error, /실제 존재하는 YYYY-MM-DD/);
});

test('시간 형식을 검사한다', () => {
  assert.match(build({ time: '24:00' }).error, /HH:MM 형식/);
  assert.match(build({ 'time-to': '9:5' }).error, /HH:MM 형식/);
});

test('출발역과 도착역이 같으면 막는다', () => {
  assert.match(build({ to: '광명' }).error, /출발역과 도착역은 달라야/);
});

test('승객 수 합계는 1~9명이어야 한다', () => {
  assert.match(build({ adults: '0' }).error, /1~9명/);
  assert.match(build({ adults: '9', children: '1' }).error, /1~9명/);
  assert.match(build({ adults: '-1' }).error, /0 이상의 정수/);
});

test('좌석 등급은 정해진 값만 받는다', () => {
  assert.match(build({ 'seat-class': 'first' }).error, /gen, any, spe, standing/);
  assert.equal(build({ 'seat-class': 'ANY' }).config.seatClass, 'any');
});

test('--reserve와 --dry-run-reserve는 함께 쓸 수 없다', () => {
  assert.match(build({ reserve: 'true', 'dry-run-reserve': 'true' }).error, /함께 사용할 수 없습니다/);
});

test('유아를 성인과 붙일 수 없는 조합은 예약을 막는다', () => {
  assert.match(build({ adults: '1', infants: '2', reserve: 'true' }).error, /성인 수가 유아 수 이상/);
  // 감시만 할 때는 좌석을 고르지 않으므로 통과시킨다
  assert.equal(build({ adults: '1', infants: '2' }).error, undefined);
});

test('입석·자유석은 자동 예약을 지원하지 않는다', () => {
  assert.match(build({ 'seat-class': 'standing', reserve: 'true' }).error, /자동 예약을 지원하지 않습니다/);
  assert.equal(build({ 'seat-class': 'standing' }).error, undefined);
});

test('텔레그램 설정이 없으면 전송을 끄고 경고만 남긴다', () => {
  const { config } = build({}, NO_CREDS);
  assert.equal(config.telegram, false);
  assert.equal(config.warnings.length, 2);
  assert.ok(config.warnings.some(text => text.includes('텔레그램')));
  assert.ok(config.warnings.some(text => text.includes('코레일 아이디')));
});

test('예약인데 알림을 보낼 수 없으면 터미널을 보라고 알려준다', () => {
  const { config } = build({ reserve: 'true', 'no-telegram': 'true' }, FULL_CREDS);
  assert.equal(config.telegram, false);
  assert.ok(config.warnings.some(text => text.includes('터미널을 지켜보세요')));
});

test('설정이 갖춰지면 경고 없이 텔레그램을 켠다', () => {
  const { config } = build({}, FULL_CREDS);
  assert.equal(config.telegram, true);
  assert.deepEqual(config.warnings, []);
});
