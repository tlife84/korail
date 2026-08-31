import test from 'node:test';
import assert from 'node:assert/strict';
import { availableSeats, isSoldOut, statusMarker, withinDepartureRange } from './seat-availability.js';

const train = extra => ({ h_trn_no: '451', h_dpt_tm: '051000', ...extra });

test('매진 판정은 빈 값과 "매진"을 모두 매진으로 본다', () => {
  assert.equal(isSoldOut('매진'), true);
  assert.equal(isSoldOut(''), true);
  assert.equal(isSoldOut(undefined), true);
  assert.equal(isSoldOut('23,700'), false);
});

test('gen은 일반실만, spe는 특실만 본다', () => {
  const t = train({ h_gen_rsv_nm: '23,700', h_spe_rsv_nm: '33,700' });
  assert.deepEqual(availableSeats(t, 'gen'), [{ label: '일반실', state: '23,700', psrmClCd: '1' }]);
  assert.deepEqual(availableSeats(t, 'spe'), [{ label: '특실', state: '33,700', psrmClCd: '2' }]);
});

test('알 수 없는 좌석 종류는 일반실로 되돌린다', () => {
  const t = train({ h_gen_rsv_nm: '23,700' });
  assert.deepEqual(availableSeats(t, '이상한값'), [{ label: '일반실', state: '23,700', psrmClCd: '1' }]);
});

test('일반실이 매진이면 공석으로 보지 않는다', () => {
  assert.deepEqual(availableSeats(train({ h_gen_rsv_nm: '매진' }), 'gen'), []);
});

test('any는 전체 예약가능 표시가 Y일 때만 등급을 살펴본다', () => {
  const open = train({ h_rsv_psb_flg: 'Y', h_gen_rsv_nm: '23,700', h_spe_rsv_nm: '매진' });
  assert.deepEqual(availableSeats(open, 'any').map(s => s.label), ['일반실']);

  const closed = train({ h_rsv_psb_flg: 'N', h_gen_rsv_nm: '23,700' });
  assert.deepEqual(availableSeats(closed, 'any'), [], '전체 표시가 N이면 등급을 보지 않는다');
});

test('any는 등급이 명시되지 않은 예약가능(입석 등)을 공석으로 보지 않는다', () => {
  const standingOnly = train({ h_rsv_psb_flg: 'Y', h_gen_rsv_nm: '매진', h_spe_rsv_nm: '매진', h_stnd_rsv_nm: '입석' });
  assert.deepEqual(availableSeats(standingOnly, 'any'), []);
  assert.deepEqual(availableSeats(standingOnly, 'standing').map(s => s.label), ['입석·자유석']);
});

test('입석·자유석은 좌석등급 코드가 없다', () => {
  const [seat] = availableSeats(train({ h_stnd_rsv_nm: '입석' }), 'standing');
  assert.equal(seat.psrmClCd, null, '좌석선택 검증을 건너뛰는 신호');
});

test('출발시각 범위로 열차를 걸러낸다', () => {
  const range = { depFrom: 1200, depTo: 1600 };
  assert.equal(withinDepartureRange(train({ h_dpt_tm: '115900' }), range), false);
  assert.equal(withinDepartureRange(train({ h_dpt_tm: '120000' }), range), true);
  assert.equal(withinDepartureRange(train({ h_dpt_tm: '160000' }), range), true);
  assert.equal(withinDepartureRange(train({ h_dpt_tm: '160100' }), range), false);
});

test('상한이 없으면 시작 시각 이후를 모두 포함한다', () => {
  const range = { depFrom: 1200, depTo: null };
  assert.equal(withinDepartureRange(train({ h_dpt_tm: '235900' }), range), true);
  assert.equal(withinDepartureRange(train({ h_dpt_tm: '110000' }), range), false);
});

test('출발시각이 없는 열차는 0시로 취급한다', () => {
  assert.equal(withinDepartureRange(train({ h_dpt_tm: '' }), { depFrom: 0, depTo: null }), true);
  assert.equal(withinDepartureRange(train({ h_dpt_tm: '' }), { depFrom: 1200, depTo: null }), false);
});

test('상태 표시는 좌석선택 가능 > 검증실패 > 예약가능 > 매진 순으로 정해진다', () => {
  assert.equal(statusMarker({ selectableCount: 1, candidateCount: 1, verificationUnknown: false }), '🟢');
  assert.equal(statusMarker({ selectableCount: 1, candidateCount: 1, verificationUnknown: true }), '🟢');
  assert.equal(statusMarker({ selectableCount: 0, candidateCount: 1, verificationUnknown: true }), '?');
  assert.equal(statusMarker({ selectableCount: 0, candidateCount: 1, verificationUnknown: false }), '🟡');
  assert.equal(statusMarker({ selectableCount: 0, candidateCount: 0, verificationUnknown: false }), '·');
});
