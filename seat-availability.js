/**
 * 시간표 응답 한 건에서 "감시 대상 좌석이 예약 가능한가"를 판정한다.
 * 좌석을 실제로 고를 수 있는지(호차 조회)는 별도 검증이며 여기서는 다루지 않는다.
 */

// seatClass → [응답 필드, 표시 이름, 좌석등급 코드(psrmClCd)]
export const CLASS_FIELD = {
  gen: ['h_gen_rsv_nm', '일반실', '1'],
  spe: ['h_spe_rsv_nm', '특실', '2'],
  standing: ['h_stnd_rsv_nm', '입석·자유석', null],
};

export const isSoldOut = (value) => !value || value === '매진' || value === '';

/** seatClass: gen | any | spe | standing */
export const availableSeats = (train, seatClass) => {
  const out = [];
  if (seatClass === 'any') {
    if (train.h_rsv_psb_flg === 'Y') {
      if (!isSoldOut(train.h_gen_rsv_nm)) out.push({ label: '일반실', state: train.h_gen_rsv_nm, psrmClCd: '1' });
      if (!isSoldOut(train.h_spe_rsv_nm)) out.push({ label: '특실', state: train.h_spe_rsv_nm, psrmClCd: '2' });
      // 등급이 명시되지 않는 예약 가능 상태(입석 등)는 기본 any에서 공석으로 보지 않는다.
      // 입석·자유석만 감시하려면 seatClass를 standing으로 지정해야 한다.
    }
    return out;
  }
  const [field, label, psrmClCd] = CLASS_FIELD[seatClass] || CLASS_FIELD.gen;
  if (!isSoldOut(train[field])) out.push({ label, state: train[field], psrmClCd });
  return out;
};

/** 출발시각 범위 필터. depFrom/depTo는 HHMM 정수, depTo가 null이면 상한 없음. */
export const withinDepartureRange = (train, { depFrom, depTo }) => {
  const departure = parseInt((train.h_dpt_tm || '0').slice(0, 4));
  if (departure < depFrom) return false;
  if (depTo != null && departure > depTo) return false;
  return true;
};

/**
 * 콘솔 한 줄 상태 표시.
 * 🟢 좌석선택 가능 · 🟡 예약가능 표시는 있으나 조합 없음 · ? 검증 실패 · · 매진
 */
export const statusMarker = ({ selectableCount, candidateCount, verificationUnknown }) => {
  if (selectableCount) return '🟢';
  if (verificationUnknown) return '?';
  return candidateCount ? '🟡' : '·';
};
