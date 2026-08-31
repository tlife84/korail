import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ENDPOINTS, PRIMED_MSG_CD, buildScheduleBody, buildSeatMapBody, buildSeatListBody,
  apiFailed, apiErrorMessage, isPrimed, sessionExpired, reservationFailed,
} from './korail-api.js';

const config = {
  date: '20260907', from: '광명', to: '서대전', hour: '120000',
  adults: 2, children: 1, infants: 1, seniors: 0,
};

const train = {
  h_run_dt: '20260907', h_dpt_dt: '20260907', h_trn_no: '451', h_dpt_tm: '051000',
  h_trn_clsf_cd: '00', h_trn_gp_cd: '100', h_dpt_rs_stn_cd: '0015', h_arv_rs_stn_cd: '0168',
  h_seat_att_cd: '015', h_dpt_stn_run_ordr: '000002', h_arv_stn_run_ordr: '000005',
};

const params = body => new URLSearchParams(body);

test('시간표 조회 파라미터에 승객 종류를 코레일 인덱스로 매핑한다', () => {
  const body = params(buildScheduleBody(config));
  assert.equal(body.get('txtGoAbrdDt'), '20260907');
  assert.equal(body.get('txtGoStart'), '광명');
  assert.equal(body.get('txtGoEnd'), '서대전');
  assert.equal(body.get('txtGoHour'), '120000');
  assert.equal(body.get('txtPsgFlg_1'), '2', '1=어른');
  assert.equal(body.get('txtPsgFlg_2'), '1', '2=어린이');
  assert.equal(body.get('txtPsgFlg_3'), '0', '3=경로');
  assert.equal(body.get('txtPsgFlg_4'), '1', '4=유아');
});

test('좌석선택 조회는 열차 식별값과 전체 승객 수를 함께 보낸다', () => {
  const body = params(buildSeatMapBody(train, { seatClassCode: '1', date: '20260907', totalPassengers: 4 }));
  assert.equal(body.get('txtTrnNo'), '451');
  assert.equal(body.get('txtPsrmClCd'), '1');
  assert.equal(body.get('txtTotPsgCnt'), '4');
  assert.equal(body.get('txtDptStnRunOrdr'), '000002');
});

test('열차 응답에 값이 없으면 날짜와 기본 좌석속성으로 대체한다', () => {
  const body = params(buildSeatMapBody({}, { seatClassCode: '2', date: '20260910', totalPassengers: 1 }));
  assert.equal(body.get('txtRunDt'), '20260910');
  assert.equal(body.get('txtDptDt'), '20260910');
  assert.equal(body.get('txtSeatAttCd'), '015');
  assert.equal(body.get('txtTrnNo'), '');
});

test('좌석 목록 조회는 호차 번호를 문자열로 넣는다', () => {
  const body = params(buildSeatListBody(train, { seatClassCode: '1', carNo: 9, date: '20260907', totalPassengers: 2 }));
  assert.equal(body.get('srcarNo'), '9');
  assert.equal(body.get('psrmClCd'), '1');
  assert.equal(body.get('totPsgCnt'), '2');
});

test('실패 판정: HTTP 실패, errCode, strResult=FAIL, ERR/WRG 코드', () => {
  assert.equal(apiFailed({ ok: false, text: 'html' }), true);
  assert.equal(apiFailed({ ok: true, json: { errCode: 'macro_err1' } }), true);
  assert.equal(apiFailed({ ok: true, json: { strResult: 'FAIL' } }), true);
  assert.equal(apiFailed({ ok: true, json: { h_msg_cd: 'ERR211110' } }), true);
  assert.equal(apiFailed({ ok: true, json: { h_msg_cd: 'WRG000000' } }), true);
  assert.equal(apiFailed({ ok: true, json: { h_msg_cd: PRIMED_MSG_CD } }), false);
});

test('오류 문구는 errMsg → h_msg_txt → 본문 순으로 고른다', () => {
  assert.equal(apiErrorMessage({ ok: true, json: { errMsg: '차단' } }), '차단');
  assert.equal(apiErrorMessage({ ok: true, json: { h_msg_txt: '매진' } }), '매진');
  assert.equal(apiErrorMessage({ ok: false, text: '<html>' }), '<html>');
  assert.equal(apiErrorMessage({ ok: false }), 'unknown');
});

test('예열 통과는 IRG000000일 때만 인정한다', () => {
  assert.equal(isPrimed({ ok: true, json: { h_msg_cd: 'IRG000000' } }), true);
  assert.equal(isPrimed({ ok: true, json: { errCode: 'macro_err1' } }), false, 'dynaPath 차단');
  assert.equal(isPrimed({ ok: true, json: {} }), false);
  assert.equal(isPrimed({ ok: false, text: 'blocked' }), false);
});

test('예약 판정: SUCC 계열만 성공, P058은 세션 만료로 실패', () => {
  assert.equal(reservationFailed({ ok: true, json: { strResult: 'SUCC' } }), false);
  assert.equal(reservationFailed({ ok: true, json: { strResult: 'SUCC_NULL' } }), false);
  assert.equal(reservationFailed({ ok: true, json: { strResult: 'SUCC', h_msg_cd: 'P058' } }), true);
  assert.equal(reservationFailed({ ok: true, json: {} }), true);
  assert.equal(sessionExpired({ ok: true, json: { h_msg_cd: 'P058' } }), true);
  assert.equal(sessionExpired({ ok: true, json: { h_msg_cd: 'IRG000000' } }), false);
});

test('엔드포인트 경로가 코레일 클래스 주소를 유지한다', () => {
  assert.equal(ENDPOINTS.schedule, '/classes/com.korail.mobile.seatMovie.ScheduleView');
  assert.equal(ENDPOINTS.seatMap, '/classes/com.korail.mobile.research.TrainResearch');
  assert.equal(ENDPOINTS.seatList, '/classes/com.korail.mobile.research.TResidualSeatsResearch.do');
  assert.equal(ENDPOINTS.reservation, '/classes/com.korail.mobile.certification.TicketReservation');
});
