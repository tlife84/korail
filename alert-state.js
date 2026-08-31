/**
 * 같은 열차·좌석등급을 반복 알리지 않도록 상태를 들고 있다.
 * 매진으로 돌아가면 해제해서, 다시 공석이 나면 또 알린다.
 */

// 해제 대상 등급 목록. '예약가능'은 좌석검증 없이 알렸던 과거 상태를 정리하기 위해 남겨둔다.
export const ALERT_LABELS = ['일반실', '특실', '입석·자유석', '예약가능'];

export const createAlertTracker = () => {
  const alerted = new Set();
  const key = (trainNo, label) => `${trainNo}|${label}`;

  return {
    /** 이번에 새로 알릴 대상이면 true (그리고 알림 완료로 기록한다). */
    claim(trainNo, label) {
      const id = key(trainNo, label);
      if (alerted.has(id)) return false;
      alerted.add(id);
      return true;
    },

    /**
     * 지금 선택 가능한 등급만 남기고 나머지는 해제한다.
     * 검증 자체가 실패한 주기에는 호출하지 않아야 중복 알림을 막을 수 있다.
     */
    release(trainNo, availableLabels) {
      const keep = new Set(availableLabels);
      for (const label of ALERT_LABELS) {
        if (!keep.has(label)) alerted.delete(key(trainNo, label));
      }
    },

    has: (trainNo, label) => alerted.has(key(trainNo, label)),
    get size() { return alerted.size; },
  };
};
