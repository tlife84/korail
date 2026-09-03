import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunRequest } from './watch-request.js';

const INPUT = {
  date: '2026-09-20',
  from: '광명',
  to: '서대전',
  time: '12:00',
  adults: 2,
  children: 0,
  infants: 0,
  seniors: 0,
  seatClass: 'gen',
  interval: 60,
  mode: 'notify',
  telegram: true,
};

test('화면 입력을 엔진 설정과 미리보기 명령어로 바꾼다', () => {
  const request = buildRunRequest(INPUT);
  assert.equal(request.error, undefined);
  assert.equal(request.config.date, '20260920');
  assert.equal(request.config.dateLabel, '2026-09-20');
  assert.equal(request.config.hour, '120000');
  assert.equal(request.config.totalPassengers, 2);
  assert.equal(request.command, 'node watch.js --date 2026-09-20 --time 12:00 --from 광명 --to 서대전 --adults 2 --children 0 --infants 0 --seniors 0 --seat-class gen --interval 60');
});

test('비밀번호와 토큰은 인자가 아니라 환경변수로만 나간다', () => {
  const request = buildRunRequest({
    ...INPUT,
    korailId: 'tester',
    korailPw: 'secret',
    telegramToken: '123456789:AAaaBBbbCCccDDddEEeeFFffGGgg',
    telegramChatIds: '556744257',
  });
  assert.equal(request.error, undefined);
  assert.ok(!request.command.includes('secret'));
  assert.ok(!request.command.includes('tester'));
  assert.ok(!request.args.includes('secret'));
  assert.equal(request.credentialEnv.KORAIL_PW, 'secret');
  assert.equal(request.creds.hasKorailLogin, true);
  assert.equal(request.creds.hasTelegram, true);
  assert.equal(request.config.telegram, true);
  assert.deepEqual(request.warnings, []);
});

test('모드를 예약으로 고르면 설정에도 예약으로 넘어간다', () => {
  const request = buildRunRequest({ ...INPUT, mode: 'reserve' });
  assert.equal(request.config.reserve, true);
  assert.equal(request.config.dryRunReserve, false);
  assert.ok(request.command.includes('--reserve'));
});

test('선택 테스트 모드는 예약 요청을 보내지 않는 설정이 된다', () => {
  const request = buildRunRequest({ ...INPUT, mode: 'dry-run' });
  assert.equal(request.config.dryRunReserve, true);
  assert.equal(request.config.reserve, false);
});

test('텔레그램 설정이 없으면 경고를 함께 돌려준다', () => {
  const request = buildRunRequest(INPUT);
  assert.equal(request.config.telegram, false);
  assert.equal(request.warnings, request.config.warnings);
  assert.ok(request.warnings.some(text => text.includes('텔레그램')));
});

test('화면 입력이 잘못되면 사람이 읽을 문구 하나만 돌려준다', () => {
  assert.equal(buildRunRequest({ ...INPUT, date: '2026-02-30' }).error, '실제로 존재하는 날짜를 선택하세요.');
  assert.equal(buildRunRequest({ ...INPUT, to: '광명' }).error, '출발역과 도착역은 달라야 합니다.');
  assert.match(buildRunRequest({ ...INPUT, korailId: 'tester' }).error, /코레일 비밀번호도 함께/);
  assert.match(buildRunRequest({ ...INPUT, interval: 5 }).error, /15~86400초/);
  assert.equal(buildRunRequest({ ...INPUT, date: '2026-02-30' }).config, undefined);
});

test('입력이 아예 없어도 던지지 않고 문구로 알려준다', () => {
  assert.match(buildRunRequest().error, /날짜을\(를\) 입력하세요\./);
});
