/**
 * 코레일 API 계약 — 요청 파라미터 조립과 응답 판정.
 *
 * 이 파일은 브라우저도 네트워크도 모른다. 전역 설정을 읽지 않고 필요한 값을
 * 인자로만 받으므로, 감시 엔진을 CLI에서 쓰든 앱에서 쓰든 그대로 재사용된다.
 */

export const ENDPOINTS = {
  schedule: '/classes/com.korail.mobile.seatMovie.ScheduleView',
  seatMap: '/classes/com.korail.mobile.research.TrainResearch',
  seatList: '/classes/com.korail.mobile.research.TResidualSeatsResearch.do',
  reservation: '/classes/com.korail.mobile.certification.TicketReservation',
  loginCheck: '/ebizweb/common/loginCheck',
};

// 예열이 통과했을 때 조회 API가 돌려주는 정상 코드
export const PRIMED_MSG_CD = 'IRG000000';
// 로그인 세션 만료 코드
export const SESSION_EXPIRED_MSG_CD = 'P058';

// ---------- 요청 파라미터 ----------

/** 시간표 조회. date=YYYYMMDD, hour=HHMMSS */
export const buildScheduleBody = ({ date, from, to, hour, adults, children, infants, seniors }) =>
  new URLSearchParams({
    Device: 'IP', Version: '190617001', radJobId: '1', txtMenuId: '11', selGoTrain: '05',
    txtGoAbrdDt: date, txtGoStart: from, txtGoEnd: to, txtGoHour: hour,
    // 코레일 인덱스: 1=어른, 2=어린이, 3=경로, 4=유아
    txtPsgFlg_1: String(adults), txtPsgFlg_2: String(children),
    txtPsgFlg_3: String(seniors), txtPsgFlg_4: String(infants), txtPsgFlg_5: '0',
    txtSeatAttCd_2: '000', txtSeatAttCd_3: '000', txtSeatAttCd_4: '015',
    txtTrnGpCd: '109', adjStnScdlOfrFlg: 'N', rtYn: 'N', txtCardPsgCnt: '0',
  }).toString();

/**
 * 코레일 웹의 "좌석선택" 버튼과 같은 요청. 지정 승객 수가 함께 앉을 수 있는
 * 좌석 조합이 하나라도 있어야 응답에 srcar_infos(선택 가능한 호차)가 생긴다.
 */
export const buildSeatMapBody = (train, { seatClassCode, date, totalPassengers }) =>
  new URLSearchParams({
    Device: 'IP',
    Version: '190617001',
    txtMenuId: '11',
    txtRunDt: train.h_run_dt || date,
    txtDptDt: train.h_dpt_dt || train.h_run_dt || date,
    txtTrnNo: train.h_trn_no || '',
    txtDptTm: train.h_dpt_tm || '',
    txtTrnClsfCd: train.h_trn_clsf_cd || '',
    txtTrnGpCd: train.h_trn_gp_cd || '',
    txtDptRsStnCd: train.h_dpt_rs_stn_cd || '',
    txtArvRsStnCd: train.h_arv_rs_stn_cd || '',
    txtPsrmClCd: seatClassCode, // 1=일반실, 2=특실
    txtSeatAttCd: train.h_seat_att_cd || '015',
    txtCustSrtCd: '',
    txtDptStnRunOrdr: train.h_dpt_stn_run_ordr || '',
    txtArvStnRunOrdr: train.h_arv_stn_run_ordr || '',
    txtTotPsgCnt: String(totalPassengers),
    langCode: 'ko',
    txtGdNo: train.txtGdNo || '',
  }).toString();

/** 호차 하나의 좌석 목록 */
export const buildSeatListBody = (train, { seatClassCode, carNo, date, totalPassengers }) =>
  new URLSearchParams({
    Device: 'IP',
    Version: '190617001',
    runDt: train.h_run_dt || date,
    trnNo: train.h_trn_no || '',
    trnClsfCd: train.h_trn_clsf_cd || '',
    trnGpCd: train.h_trn_gp_cd || '',
    dptRsStnCd: train.h_dpt_rs_stn_cd || '',
    arvRsStnCd: train.h_arv_rs_stn_cd || '',
    psrmClCd: seatClassCode,
    seatAttCd: train.h_seat_att_cd || '015',
    dptStnRunOrdr: train.h_dpt_stn_run_ordr || '',
    arvStnRunOrdr: train.h_arv_stn_run_ordr || '',
    totPsgCnt: String(totalPassengers),
    srcarNo: String(carNo),
    langCode: 'ko',
    gdNo: train.txtGdNo || '',
  }).toString();

// ---------- 응답 판정 ----------

export const apiFailed = (res) => !res.ok
  || !!res.json?.errCode
  || res.json?.strResult === 'FAIL'
  || /^(ERR|WRG)/.test(res.json?.h_msg_cd || '');

export const apiErrorMessage = (res) => res.json?.errMsg
  || res.json?.h_msg_txt
  || res.text
  || 'unknown';

/** dynaPath 예열이 통과했는지 — 조회 응답만으로 판정한다. */
export const isPrimed = (res) => !apiFailed(res) && res.json?.h_msg_cd === PRIMED_MSG_CD;

export const sessionExpired = (res) => res.json?.h_msg_cd === SESSION_EXPIRED_MSG_CD;

export const reservationFailed = (res) => apiFailed(res)
  || !['SUCC', 'SUCC_NULL'].includes(res.json?.strResult)
  || sessionExpired(res);
