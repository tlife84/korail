/**
 * 감시 엔진 오케스트레이션 테스트.
 *
 * 진짜 Chrome 없이 가짜 page 하나만 주입해 "예열 재시도 → 조회 → 좌석검증 →
 * 예약 → 종료"까지의 흐름을 돌린다. 개별 판정 로직은 각 모듈 테스트가 맡고,
 * 여기서는 순서·재시도·종료 조건·중복 알림 억제처럼 조합해야 드러나는 것만 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINTS } from './korail-api.js';
import { buildWatchConfig } from './watch-config.js';
import { createWatcher } from './watcher.js';

// ---------- 코레일 응답 픽스처 ----------
const ok = json => ({ ok: true, json });

const PRIMED = 'IRG000000';
const scheduleOk = trains => ok({ h_msg_cd: PRIMED, trn_infos: { trn_info: trains } });
// dynaPath에 막혔을 때의 응답 (h_msg_cd가 WRG/ERR로 시작하면 실패로 본다)
const BLOCKED = ok({ h_msg_cd: 'WRG000001', h_msg_txt: 'macro_err1' });

const SEATMAP_ONE_CAR = ok({ h_msg_cd: PRIMED, srcar_infos: { srcar_info: [{ h_srcar_no: '9' }] } });
const SEATMAP_NO_CAR = ok({ h_msg_cd: PRIMED });

const seat = (spec, direction = '009') => ({
  seat_no: spec.replace(/\D/g, '').padStart(3, '0'),
  seat_spec: spec,
  sale_psb_flg: 'Y',
  dir_seat_att_cd: direction,
  intg_msg_cd: '',
  intg_msg: '',
});
const SEATLIST_PAIR = ok({ h_msg_cd: PRIMED, seatList: [seat('1A'), seat('1B')] });

const RESERVED_OK = ok({ strResult: 'SUCC', h_pnr_no: 'R12345', h_pay_limit_msg: '20분 이내' });
const RESERVE_EXPIRED = ok({ strResult: 'FAIL', h_msg_cd: 'P058', h_msg_txt: '세션이 만료되었습니다.' });
const RESERVE_NEEDS_LOGIN = ok({ strResult: 'FAIL', h_msg_txt: '로그인이 필요합니다.' });
const LOGGED_IN = ok({ strResult: 'SUCC' });
const LOGGED_OUT = ok({ strResult: 'FAIL', h_msg_cd: 'P058' });

const train = (overrides = {}) => ({
  h_trn_no: '451',
  h_trn_clsf_nm: 'KTX',
  h_dpt_tm: '073000',
  h_dpt_tm_qb: '07:30',
  h_arv_tm_qb: '08:30',
  h_rsv_psb_flg: 'Y',
  h_gen_rsv_nm: '59,800원',
  h_spe_rsv_nm: '매진',
  h_rsv_psb_nm: '59,800원',
  h_run_dt: '20260920',
  h_trn_clsf_cd: '00',
  h_trn_gp_cd: '109',
  h_dpt_rs_stn_cd: '0007',
  h_arv_rs_stn_cd: '0405',
  h_seat_att_cd: '015',
  h_dpt_stn_run_ordr: '000002',
  h_arv_stn_run_ordr: '000006',
  ...overrides,
});

// ---------- 가짜 page ----------
/** handlers: 엔드포인트 경로 → 응답(또는 호출마다 응답을 만드는 함수) */
const fakePage = (handlers) => {
  const requests = [];
  const visited = [];
  const page = {
    requests,
    visited,
    get primeCount() { return visited.filter(url => url.includes('/ticket/main')).length; },
    countOf(path) { return requests.filter(item => item.path === path).length; },
    async evaluate(_fn, arg) {
      const path = typeof arg === 'string' ? arg : arg.path;
      const body = typeof arg === 'string' ? '' : arg.body;
      requests.push({ path, body });
      const handler = handlers[path];
      if (handler === undefined) throw new Error(`가짜 page에 핸들러가 없는 경로: ${path}`);
      return typeof handler === 'function' ? handler({ body, requests }) : handler;
    },
    async goto(url) { visited.push(url); },
    async waitForTimeout() {},
    waitForResponse: () => Promise.resolve(null),
    getByText: () => ({ first: () => ({ click: async () => {} }) }),
    getByRole: () => ({ first: () => ({ click: async () => {} }) }),
    locator: () => ({
      isChecked: async () => false,
      uncheck: async () => {},
      fill: async () => {},
    }),
  };
  return page;
};

const CREDS = {
  korailId: 'tester',
  korailPw: 'secret',
  telegramToken: '',
  telegramChatIds: [],
  sources: { korailId: 'ui' },
  hasKorailLogin: true,
  hasTelegram: false,
};

const configFor = (overrides = {}) => {
  const { config, error } = buildWatchConfig({
    date: '2026-09-20', from: '광명', to: '서대전', adults: '2',
    'no-telegram': 'true', ...overrides,
  }, CREDS);
  assert.equal(error, undefined, `설정을 만들지 못했다: ${error}`);
  return config;
};

/** 엔진을 만들고 이벤트를 모아준다. start()는 호출자가 부른다. */
const harness = ({ config, page, sleep, creds = CREDS }) => {
  const logs = [];
  const telegrams = [];
  const seen = { status: [], found: [], reserved: [], error: [], end: [] };
  let closeCount = 0;
  const watcher = createWatcher({
    config,
    creds,
    deps: {
      openSession: async () => ({ page, close: async () => { closeCount++; } }),
      sendTelegram: async text => { telegrams.push(text); },
      sleep: sleep ?? (async () => {}),
      now: () => new Date('2026-09-20T03:00:00Z'),
    },
  });
  watcher.on('log', entry => logs.push(entry));
  for (const name of Object.keys(seen)) watcher.on(name, payload => seen[name].push(payload));
  return {
    watcher,
    logs,
    telegrams,
    seen,
    get closeCount() { return closeCount; },
    get text() { return logs.map(entry => entry.text).join('\n'); },
    warnings: () => logs.filter(entry => entry.level === 'warn').map(entry => entry.text),
  };
};

// ---------- 예열 ----------
test('예열은 조회가 통과할 때까지 다시 시도한다', async () => {
  let checks = 0;
  const page = fakePage({
    // 앞의 두 번은 막히고 세 번째부터 통과한다 (콜드 스타트의 실제 모습)
    [ENDPOINTS.schedule]: () => (++checks <= 2 ? BLOCKED : scheduleOk([])),
  });
  const run = harness({ config: configFor({ once: 'true' }), page });
  const outcome = await run.watcher.start();

  assert.equal(page.primeCount, 3);
  assert.ok(run.text.includes('[예열] dynaPath 신뢰 상태 확보 중... (1/5)'));
  assert.ok(run.text.includes('[예열] dynaPath 신뢰 상태 확보 중... (3/5)'));
  assert.ok(run.text.includes('[예열] 완료 ✔'));
  assert.ok(!run.text.includes('(4/5)'));
  assert.deepEqual(outcome, { code: 0, reason: 'once' });
});

test('예열이 끝내 실패하면 경고하고 주기 조회에서 한 번 더 재예열한다', async () => {
  const page = fakePage({ [ENDPOINTS.schedule]: BLOCKED });
  const run = harness({ config: configFor({ once: 'true' }), page });
  const outcome = await run.watcher.start();

  assert.ok(run.warnings().includes('[예열] 실패 — 계속 차단 상태입니다.'));
  assert.ok(run.warnings().includes('[감시] 신뢰 상태 만료 → 재예열'));
  assert.ok(run.warnings().some(text => text.startsWith('[감시] 조회 실패(다음 주기 재시도): macro_err1')));
  // 시작 예열 5회 + 주기 안 재예열 3회
  assert.equal(page.primeCount, 8);
  assert.equal(outcome.reason, 'once');
});

// ---------- 주기 루프 ----------
test('주기 루프는 stop 할 때까지 돌고 설정한 간격만큼 쉰다', async () => {
  let cycles = 0;
  const page = fakePage({
    [ENDPOINTS.schedule]: () => { cycles++; return scheduleOk([train()]); },
    [ENDPOINTS.seatMap]: SEATMAP_NO_CAR,
  });
  const waits = [];
  const run = harness({
    config: configFor({ interval: '45' }),
    page,
    sleep: async ms => {
      waits.push(ms);
      if (waits.length === 3) run.watcher.stop();
    },
  });
  const outcome = await run.watcher.start();

  // 예열에서 1회, 주기마다 1회
  assert.equal(cycles - 1, 3);
  assert.deepEqual(waits, [45000, 45000, 45000]);
  assert.deepEqual(outcome, { code: 0, reason: 'stopped' });
  assert.equal(run.closeCount, 1);
});

test('주기 안에서 예외가 나도 감시는 계속된다', async () => {
  let cycles = 0;
  const page = fakePage({
    [ENDPOINTS.schedule]: () => {
      cycles++;
      if (cycles === 2) throw new Error('브라우저 연결 끊김');
      return scheduleOk([]);
    },
  });
  const waits = [];
  const run = harness({
    config: configFor({}),
    page,
    sleep: async () => { if (waits.push(1) === 2) run.watcher.stop(); },
  });
  const outcome = await run.watcher.start();

  assert.ok(run.warnings().includes('[cycle 오류] 브라우저 연결 끊김'));
  assert.equal(outcome.reason, 'stopped');
});

// ---------- 알림 ----------
test('같은 열차의 공석은 한 번만 알린다', async () => {
  const page = fakePage({
    [ENDPOINTS.schedule]: scheduleOk([train()]),
    [ENDPOINTS.seatMap]: SEATMAP_ONE_CAR,
  });
  const waits = [];
  const run = harness({
    config: configFor({}),
    page,
    sleep: async () => { if (waits.push(1) === 2) run.watcher.stop(); },
  });
  await run.watcher.start();

  assert.equal(run.seen.status.length, 2);
  assert.equal(run.seen.found.length, 1);
  assert.equal(run.telegrams.length, 1);
  assert.deepEqual(run.seen.found[0].hits.map(hit => `${hit.name} ${hit.label}`), ['KTX 451 일반실']);
  assert.deepEqual(run.seen.status[0].markers, ['451:🟢']);
});

test('좌석검증이 실패하면 판정을 보류하고 알리지 않는다', async () => {
  const page = fakePage({
    [ENDPOINTS.schedule]: scheduleOk([train()]),
    [ENDPOINTS.seatMap]: BLOCKED,
  });
  const run = harness({ config: configFor({ once: 'true' }), page });
  await run.watcher.start();

  assert.ok(run.warnings().includes('[좌석검증] 451 일반실 조회 오류 → 재예열'));
  assert.ok(run.warnings().some(text => text.startsWith('[좌석검증] 451 일반실 판정 보류: macro_err1')));
  assert.deepEqual(run.seen.status[0].markers, ['451:?']);
  assert.equal(run.seen.found.length, 0);
});

test('--trains로 지정하지 않은 열차는 건너뛴다', async () => {
  const page = fakePage({
    [ENDPOINTS.schedule]: scheduleOk([train(), train({ h_trn_no: '453' })]),
    [ENDPOINTS.seatMap]: SEATMAP_ONE_CAR,
  });
  const run = harness({ config: configFor({ once: 'true', trains: '453' }), page });
  await run.watcher.start();

  assert.deepEqual(run.seen.status[0].markers, ['453:🟢']);
  assert.equal(run.seen.status[0].targetCount, 2);
});

// ---------- 예약 ----------
test('예약 시뮬레이션은 좌석만 고르고 예약 요청은 보내지 않는다', async () => {
  const page = fakePage({
    [ENDPOINTS.schedule]: scheduleOk([train()]),
    [ENDPOINTS.seatMap]: SEATMAP_ONE_CAR,
    [ENDPOINTS.seatList]: SEATLIST_PAIR,
  });
  const run = harness({ config: configFor({ once: 'true', 'dry-run-reserve': 'true' }), page });
  const outcome = await run.watcher.start();

  assert.ok(run.text.includes('[좌석선택] KTX 451 일반실 → 9호차 1A, 1B | 인접쌍 1 | 순방향 2 | 4인동반석 0'));
  assert.equal(page.countOf(ENDPOINTS.reservation), 0);
  assert.equal(run.seen.reserved.length, 0);
  assert.deepEqual(outcome, { code: 0, reason: 'once' });
});

test('예약이 성공하면 알리고 첫 건에서 감시를 끝낸다', async () => {
  const page = fakePage({
    [ENDPOINTS.schedule]: scheduleOk([train(), train({ h_trn_no: '453' })]),
    [ENDPOINTS.seatMap]: SEATMAP_ONE_CAR,
    [ENDPOINTS.seatList]: SEATLIST_PAIR,
    [ENDPOINTS.reservation]: RESERVED_OK,
    [ENDPOINTS.loginCheck]: LOGGED_IN,
  });
  const run = harness({ config: configFor({ reserve: 'true' }), page });
  const outcome = await run.watcher.start();

  assert.equal(page.countOf(ENDPOINTS.reservation), 1, '두 번째 열차까지 예약하면 안 된다');
  assert.equal(run.seen.reserved.length, 1);
  assert.equal(run.seen.reserved[0].summary, 'KTX 451 9호차 1A, 9호차 1B | 결제기한 20분 이내 | 예약번호 R12345');
  assert.equal(run.telegrams.length, 1);
  assert.ok(run.telegrams[0].includes('✅ 코레일 예약 완료'));
  assert.deepEqual(outcome, { code: 0, reason: 'reserved' });
  assert.equal(run.closeCount, 1);
});

test('예약 중 세션이 만료되면(P058) 다시 로그인하고 한 번 더 시도한다', async () => {
  let reservations = 0;
  const page = fakePage({
    [ENDPOINTS.schedule]: scheduleOk([train()]),
    [ENDPOINTS.seatMap]: SEATMAP_ONE_CAR,
    [ENDPOINTS.seatList]: SEATLIST_PAIR,
    [ENDPOINTS.reservation]: () => (++reservations === 1 ? RESERVE_EXPIRED : RESERVED_OK),
    [ENDPOINTS.loginCheck]: LOGGED_IN,
  });
  const run = harness({ config: configFor({ reserve: 'true' }), page });
  const outcome = await run.watcher.start();

  assert.ok(run.warnings().includes('[예약] 로그인 세션이 만료되어 다시 로그인합니다.'));
  assert.equal(reservations, 2);
  assert.equal(run.seen.reserved.length, 1);
  assert.deepEqual(outcome, { code: 0, reason: 'reserved' });
});

test('로그인 자체가 안 되면 알리고 감시를 중단한다', async () => {
  const page = fakePage({
    [ENDPOINTS.schedule]: scheduleOk([train()]),
    [ENDPOINTS.seatMap]: SEATMAP_ONE_CAR,
    [ENDPOINTS.seatList]: SEATLIST_PAIR,
    [ENDPOINTS.reservation]: RESERVE_NEEDS_LOGIN,
    [ENDPOINTS.loginCheck]: LOGGED_IN,
  });
  const run = harness({ config: configFor({ reserve: 'true' }), page });
  const outcome = await run.watcher.start();

  assert.ok(run.warnings().includes('[예약] KTX 451 일반실 실패: 로그인이 필요합니다.'));
  assert.ok(run.telegrams[0].includes('코레일 자동 예약 중단'));
  assert.deepEqual(outcome, { code: 2, reason: 'fatal' });
  assert.equal(run.closeCount, 1);
});

test('세션 만료 후 재로그인까지 실패하면 반복 시도하지 않는다', async () => {
  let logins = 0;
  const page = fakePage({
    [ENDPOINTS.schedule]: scheduleOk([train()]),
    [ENDPOINTS.seatMap]: SEATMAP_ONE_CAR,
    [ENDPOINTS.seatList]: SEATLIST_PAIR,
    [ENDPOINTS.reservation]: RESERVE_EXPIRED,
    // 시작 시엔 로그인 상태, 예약 중 만료된 뒤로는 계속 로그아웃 상태
    [ENDPOINTS.loginCheck]: () => (++logins === 1 ? LOGGED_IN : LOGGED_OUT),
  });
  const run = harness({ config: configFor({ reserve: 'true' }), page });
  const outcome = await run.watcher.start();

  assert.ok(run.warnings().some(text => text.includes('[로그인] 실패')));
  assert.deepEqual(outcome, { code: 2, reason: 'fatal' });
});

// ---------- 로그인 전용 / 세션 ----------
test('--login은 로그인만 확인하고 조용히 끝낸다', async () => {
  const page = fakePage({ [ENDPOINTS.loginCheck]: LOGGED_IN });
  const run = harness({ config: configFor({ login: 'true' }), page });
  const outcome = await run.watcher.start();

  assert.ok(run.text.includes('=== 코레일 로그인 세션 준비 ==='));
  assert.ok(run.text.includes('[로그인] 이미 로그인되어 있습니다 ✔'));
  assert.ok(!run.text.includes('종료 중...'), '로그인 준비만 하고 끝날 때는 종료 문구를 찍지 않는다');
  assert.deepEqual(outcome, { code: 0, reason: 'login' });
  assert.equal(run.closeCount, 1);
});

test('브라우저를 열지 못하면 error 이벤트로 알리고 1로 끝낸다', async () => {
  const failures = [];
  const watcher = createWatcher({
    config: configFor({ once: 'true' }),
    creds: CREDS,
    deps: {
      openSession: async () => { throw new Error('Chrome 실행파일을 찾지 못했습니다.'); },
      sendTelegram: async () => {},
      sleep: async () => {},
    },
  });
  watcher.on('error', payload => failures.push(payload.error.message));
  const outcome = await watcher.start();

  assert.deepEqual(failures, ['Chrome 실행파일을 찾지 못했습니다.']);
  assert.equal(outcome.code, 1);
  assert.equal(outcome.reason, 'error');
});

test('close는 여러 번 불러도 브라우저를 한 번만 닫는다', async () => {
  const page = fakePage({ [ENDPOINTS.schedule]: scheduleOk([]) });
  const run = harness({ config: configFor({ once: 'true' }), page });
  await run.watcher.start();
  await run.watcher.close();
  await run.watcher.close();

  assert.equal(run.closeCount, 1);
});
