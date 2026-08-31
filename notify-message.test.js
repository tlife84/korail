import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReservationMessage, buildVacancyMessage, departureRangeLabel,
  escapeHtml, rawTimeLabel, reservationPaymentLabel,
} from './notify-message.js';

test('텔레그램 HTML 특수문자를 이스케이프한다', () => {
  assert.equal(escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
  assert.equal(escapeHtml(null), '');
});

test('코레일 시각 문자열을 HH:MM으로 바꾼다', () => {
  assert.equal(rawTimeLabel('051000'), '05:10');
  assert.equal(rawTimeLabel('0510'), '05:10');
  assert.equal(rawTimeLabel('510'), '510', '자리수가 모자라면 원문 유지');
  assert.equal(rawTimeLabel(''), '');
});

test('결제기한은 안내 문구 → 시각 → 기본 문구 순으로 고른다', () => {
  assert.equal(reservationPaymentLabel({ h_pay_limit_msg: '20분 내 결제' }), '20분 내 결제');
  assert.equal(reservationPaymentLabel({ h_stl_lmt_tm: '20260907183000' }), '18:30');
  assert.equal(reservationPaymentLabel({}), '코레일 예약내역에서 확인');
});

test('감시 범위 라벨은 상한이 없으면 물결로 끝난다', () => {
  assert.equal(departureRangeLabel('12:00', '16:00'), '12:00~16:00');
  assert.equal(departureRangeLabel('12:00', null), '12:00~');
});

const hit = extra => ({
  name: 'KTX 451', dep: '05:10', arv: '06:12', label: '일반실',
  seatSelectable: true, carCount: 3, price: '23,700원', ...extra,
});

test('공석 알림에 조건과 열차별 좌석 상태를 담는다', () => {
  const message = buildVacancyMessage({
    from: '광명', to: '서대전', dateLabel: '2026-09-07', rangeLabel: '00:00~', hits: [hit()],
  });
  assert.match(message, /코레일 공석 발생/);
  assert.match(message, /광명 → 서대전 {2}2026-09-07 00:00~/);
  assert.match(message, /KTX 451/);
  assert.match(message, /일반실 좌석선택 가능 \(3개 호차\) \(23,700원\)/);
});

test('좌석선택이 불가한 등급은 예약가능으로만 표시한다', () => {
  const message = buildVacancyMessage({
    from: '광명', to: '서대전', dateLabel: '2026-09-07', rangeLabel: '00:00~',
    hits: [hit({ label: '입석·자유석', seatSelectable: false, carCount: null, price: '' })],
  });
  assert.match(message, /입석·자유석 예약가능/);
  assert.doesNotMatch(message, /호차/);
});

test('여러 열차는 줄바꿈으로 이어 붙인다', () => {
  const message = buildVacancyMessage({
    from: '광명', to: '서대전', dateLabel: '2026-09-07', rangeLabel: '00:00~',
    hits: [hit(), hit({ name: 'KTX-산천 453' })],
  });
  assert.match(message, /KTX 451/);
  assert.match(message, /KTX-산천 453/);
});

const reservation = () => buildReservationMessage({
  from: '광명', to: '서대전', dateLabel: '2026-09-07',
  train: { h_trn_clsf_nm: 'KTX', h_trn_no: '451', h_dpt_tm_qb: '05:10', h_arv_tm_qb: '06:12' },
  seat: { label: '일반실' },
  option: { carNo: 9, seats: [{ seat_spec: '2A' }, { seat_spec: '2B' }] },
  data: { h_pnr_no: 'ABC123', h_pay_limit_msg: '20분 내 결제' },
});

test('예약 완료 알림에 열차·좌석·예약번호·결제기한을 담는다', () => {
  const { message, summary } = reservation();
  assert.match(message, /코레일 예약 완료/);
  assert.match(message, /KTX 451/);
  assert.match(message, /좌석: 일반실 \/ 9호차 2A, 9호차 2B/);
  assert.match(message, /예약번호: ABC123/);
  assert.match(message, /결제기한: 20분 내 결제/);
  assert.equal(summary, 'KTX 451 9호차 2A, 9호차 2B | 결제기한 20분 내 결제 | 예약번호 ABC123');
});

test('예약번호가 없으면 그 줄을 넣지 않는다', () => {
  const { message, summary } = buildReservationMessage({
    from: '광명', to: '서대전', dateLabel: '2026-09-07',
    train: { h_trn_no: '451', h_dpt_tm: '051000', h_arv_tm: '061200' },
    seat: { label: '일반실' },
    option: { carNo: 9, seats: [{ seat_spec: '2A' }] },
    data: {},
  });
  assert.doesNotMatch(message, /예약번호/);
  assert.doesNotMatch(summary, /예약번호/);
  assert.match(message, /KTX 451/, '열차 종류가 없으면 KTX로 표시');
  assert.match(message, /05:10→06:12/, 'qb 값이 없으면 원시 시각을 변환');
  assert.match(message, /결제기한: 코레일 예약내역에서 확인/);
});

test('연속된 빈 줄을 접어 한 줄만 남긴다', () => {
  const { message } = reservation();
  assert.doesNotMatch(message, /\n\n\n/);
  assert.match(message, /\n\n/, '구분용 빈 줄은 유지');
});
