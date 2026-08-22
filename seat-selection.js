const FORWARD_CODE = '009';
const BACKWARD_CODE = '010';
const FOUR_FACING_CODES = new Set(['MRR000012', 'MRR000013']);
const SIDE_PAIRS = new Set(['AB', 'CD', 'EF']);

export const parseSeatSpec = (seat) => {
  const match = String(seat?.seat_spec || '').trim().match(/^(\d+)([A-Za-z])$/);
  if (!match) return { row: null, letter: null };
  return { row: Number(match[1]), letter: match[2].toUpperCase() };
};

export const isSideBySide = (a, b) => {
  const left = parseSeatSpec(a);
  const right = parseSeatSpec(b);
  if (left.row == null || right.row == null || left.row !== right.row) return false;
  return SIDE_PAIRS.has([left.letter, right.letter].sort().join(''));
};

export const isFourFacing = (seat) => FOUR_FACING_CODES.has(seat?.intg_msg_cd)
  || String(seat?.intg_msg || '').includes('4인동반석');

const availableSeat = (seat) => seat?.sale_psb_flg === 'Y';

const adjacentPairs = (seats) => {
  const pairs = [];
  for (let i = 0; i < seats.length; i++) {
    for (let j = i + 1; j < seats.length; j++) {
      if (isSideBySide(seats[i], seats[j])) pairs.push([seats[i], seats[j]]);
    }
  }
  return pairs;
};

const metricsFor = (seats, carDistance) => {
  const pairs = adjacentPairs(seats);
  const forwardCount = seats.filter(seat => seat.dir_seat_att_cd === FORWARD_CODE).length;
  const backwardCount = seats.filter(seat => seat.dir_seat_att_cd === BACKWARD_CODE).length;
  const fourFacingCount = seats.filter(isFourFacing).length;
  const seatNumberSum = seats.reduce((sum, seat) => sum + (Number(seat.seat_no) || 999), 0);
  return {
    pairCount: pairs.length,
    forwardCount,
    backwardCount,
    fourFacingCount,
    carDistance,
    seatNumberSum,
  };
};

// 우선순위: 붙은 좌석 수 → 순방향 → 역방향 회피 → 4인동반석 회피 → 중앙 호차.
const compareMetrics = (a, b) => {
  const values = [
    [a.pairCount, b.pairCount, 1],
    [a.forwardCount, b.forwardCount, 1],
    [a.backwardCount, b.backwardCount, -1],
    [a.fourFacingCount, b.fourFacingCount, -1],
    [a.carDistance, b.carDistance, -1],
    [a.seatNumberSum, b.seatNumberSum, -1],
  ];
  for (const [left, right, direction] of values) {
    if (left !== right) return (left - right) * direction;
  }
  return 0;
};

const chooseInCar = (rawSeats, count, infants, carDistance, beamWidth = 500) => {
  const seats = rawSeats.filter(availableSeat);
  if (seats.length < count) return null;

  let states = [{ seats: [], nextIndex: 0, metrics: metricsFor([], carDistance) }];
  for (let picked = 0; picked < count; picked++) {
    const next = [];
    for (const state of states) {
      const lastPossible = seats.length - (count - picked);
      for (let i = state.nextIndex; i <= lastPossible; i++) {
        const selection = [...state.seats, seats[i]];
        next.push({
          seats: selection,
          nextIndex: i + 1,
          metrics: metricsFor(selection, carDistance),
        });
      }
    }
    next.sort((a, b) => compareMetrics(b.metrics, a.metrics));
    states = next.slice(0, beamWidth);
  }

  const valid = states.filter(state => infants === 0 || state.metrics.pairCount >= infants);
  if (!valid.length) return null;
  valid.sort((a, b) => compareMetrics(b.metrics, a.metrics));
  return valid[0];
};

// 예약 API가 승객 순서대로 좌석을 배정할 수 있으므로, 유아가 있으면
// 성인과 유아의 좌석 번호가 실제로 나란히 매핑되도록 좌석 배열도 재정렬한다.
const orderForPassengers = (seats, { adults, children, infants, seniors }) => {
  if (!infants) return seats;
  const passengerCount = adults + children + infants + seniors;
  const ordered = Array(passengerCount).fill(null);
  const used = new Set();
  const pairs = adjacentPairs(seats);
  const infantStart = adults + children;

  for (let i = 0; i < infants; i++) {
    const pair = pairs.find(([a, b]) => !used.has(a) && !used.has(b));
    if (!pair) return null;
    ordered[i] = pair[0];
    ordered[infantStart + i] = pair[1];
    used.add(pair[0]);
    used.add(pair[1]);
  }

  const remaining = seats.filter(seat => !used.has(seat));
  for (let i = 0; i < ordered.length; i++) {
    if (!ordered[i]) ordered[i] = remaining.shift();
  }
  return ordered;
};

export const chooseBestSeatOption = (carSeatMaps, passengers) => {
  const counts = {
    adults: Number(passengers.adults) || 0,
    children: Number(passengers.children) || 0,
    infants: Number(passengers.infants) || 0,
    seniors: Number(passengers.seniors) || 0,
  };
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (total < 1 || total > 9) throw new Error('좌석선택 예약은 승객 1~9명만 지원합니다.');
  if (counts.infants > counts.adults) {
    throw new Error('유아를 성인과 붙여 배정하려면 성인 수가 유아 수 이상이어야 합니다.');
  }

  const carNumbers = carSeatMaps.map(car => Number(car.carNo)).filter(Number.isFinite);
  if (!carNumbers.length) return null;
  const midpoint = (Math.min(...carNumbers) + Math.max(...carNumbers)) / 2;
  let best = null;

  for (const car of carSeatMaps) {
    const carNo = Number(car.carNo);
    if (!Number.isFinite(carNo)) continue;
    const candidate = chooseInCar(car.seats || [], total, counts.infants, Math.abs(carNo - midpoint));
    if (!candidate) continue;
    const orderedSeats = orderForPassengers(candidate.seats, counts);
    if (!orderedSeats) continue;
    const option = { carNo, seats: orderedSeats, metrics: candidate.metrics };
    if (!best || compareMetrics(option.metrics, best.metrics) > 0) best = option;
  }
  return best;
};
