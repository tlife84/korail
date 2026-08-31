/**
 * 감시 엔진 — 예열·조회·좌석검증·예약·알림의 오케스트레이션.
 *
 * 터미널을 모른다. 진행 상황은 전부 이벤트로 흘려보내고(log/status/found/reserved/error/end),
 * 브라우저는 openSession으로 주입받는다. 그래서 CLI(watch.js)와 Electron 셸이 같은
 * 엔진을 쓰고, 테스트는 가짜 page 하나로 오케스트레이션 전체를 돌려볼 수 있다.
 *
 * 끝날 때 process.exit을 부르지 않는다. start()가 { code, reason }으로 돌려주고
 * 프로세스를 어떻게 할지는 부른 쪽이 정한다 — 앱에서는 감시 하나가 끝나도 앱은 살아야 한다.
 */
import { EventEmitter } from 'node:events';
import { chooseBestSeatOption } from './seat-selection.js';
import { buildReservationBody } from './reservation-params.js';
import {
  ENDPOINTS, buildScheduleBody, buildSeatMapBody, buildSeatListBody,
  apiFailed, apiErrorMessage, isPrimed, sessionExpired, reservationFailed,
} from './korail-api.js';
import { availableSeats, withinDepartureRange, statusMarker } from './seat-availability.js';
import { createAlertTracker } from './alert-state.js';
import {
  escapeHtml, departureRangeLabel,
  buildVacancyMessage, buildReservationMessage,
} from './notify-message.js';
import { createTelegramSender } from './telegram.js';

export const createWatcher = ({ config, creds = {}, deps = {} } = {}) => {
  const events = new EventEmitter();
  // 듣는 쪽이 없을 때 'error' 이벤트는 EventEmitter가 예외로 바꿔 던진다.
  // 감시가 그것 때문에 죽으면 안 되니 빈 리스너를 미리 깔아둔다.
  events.on('error', () => {});

  const emit = (level, text) => events.emit('log', { level, text });
  const log = text => emit('info', text);
  const warn = text => emit('warn', text);

  const now = deps.now ?? (() => new Date());
  const openSession = deps.openSession ?? (async ({ log: onLog }) => {
    const { openChromeSession } = await import('./chrome.js');
    return openChromeSession({ port: config.port, profileDir: config.profileDir, log: onLog });
  });
  const sendTelegram = deps.sendTelegram ?? createTelegramSender({
    enabled: config.telegram,
    token: creds.telegramToken,
    chatIds: creds.telegramChatIds ?? [],
    warn,
  });

  let stopped = false;
  let wake = null;
  let session = null;
  let sessionClosed = false;
  const sleep = deps.sleep ?? (ms => new Promise(done => {
    const timer = setTimeout(() => { wake = null; done(); }, ms);
    wake = () => { clearTimeout(timer); wake = null; done(); };
  }));

  const alerts = createAlertTracker();

  // ---------- 코레일 호출 (브라우저 컨텍스트 안에서) ----------
  const fetchKorailApi = (page, path, body) => page.evaluate(async ({ path, body }) => {
    const resp = await fetch(`https://www.korail.com${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    const text = await resp.text();
    try { return { ok: resp.ok, json: JSON.parse(text) }; }
    catch { return { ok: false, text: text.slice(0, 200) }; }
  }, { path, body });

  const fetchKorailGet = (page, path) => page.evaluate(async (path) => {
    const resp = await fetch(`https://www.korail.com${path}`);
    const text = await resp.text();
    try { return { ok: resp.ok, json: JSON.parse(text) }; }
    catch { return { ok: false, text: text.slice(0, 200) }; }
  }, path);

  const scheduleBody = () => buildScheduleBody(config);
  const fetchSchedule = (page, body) => fetchKorailApi(page, ENDPOINTS.schedule, body);

  const fetchSeatMap = (page, train, psrmClCd) => fetchKorailApi(page, ENDPOINTS.seatMap, buildSeatMapBody(train, {
    seatClassCode: psrmClCd,
    date: config.date,
    totalPassengers: config.totalPassengers,
  }));

  const fetchSeatList = (page, train, psrmClCd, carNo) => fetchKorailApi(page, ENDPOINTS.seatList, buildSeatListBody(train, {
    seatClassCode: psrmClCd,
    carNo,
    date: config.date,
    totalPassengers: config.totalPassengers,
  }));

  // ---------- 로그인 ----------
  const loginStatus = async (page) => {
    try {
      const res = await fetchKorailGet(page, ENDPOINTS.loginCheck);
      const loggedIn = !!res.ok && res.json?.strResult === 'SUCC' && !res.json?.h_msg_cd;
      return { loggedIn, data: res.json || null };
    } catch {
      return { loggedIn: false, data: null };
    }
  };

  const loginWithCredentials = async (page) => {
    const { korailId: memberId, korailPw: password } = creds;
    if (!memberId || !password) return false;

    const origin = creds.sources?.korailId === 'file' ? '.env' : '설정 화면';
    log(`[로그인] ${origin} 계정(${memberId})으로 로그인 중...`);
    await page.goto('https://www.korail.com/ticket/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1500);
    const keySecurity = page.locator('#useKeySec');
    if (await keySecurity.isChecked().catch(() => false)) await keySecurity.uncheck();
    await page.locator('#id').fill(memberId);
    await page.locator('#password').fill(password);
    const response = page.waitForResponse(r => /\/ebizweb\/common\/loginProcess/i.test(r.url()), {
      timeout: 20000,
    }).catch(() => null);
    await page.getByRole('button', { name: '로그인', exact: true }).first().click();
    const loginResponse = await response;
    const loginData = await loginResponse?.json().catch(() => null);
    await page.waitForTimeout(2000);

    const status = await loginStatus(page);
    if (status.loggedIn) {
      log('[로그인] 완료 ✔');
      return true;
    }
    const message = loginData?.h_msg_txt || status.data?.h_msg_txt || '로그인에 실패했습니다.';
    throw new Error(`[로그인] 실패: ${message} (잘못된 정보로 반복 시도하지 않습니다.)`);
  };

  const ensureLoggedIn = async (page) => {
    const current = await loginStatus(page);
    if (current.loggedIn) {
      log('[로그인] 기존 로그인 세션 재사용 ✔');
      return true;
    }
    if (await loginWithCredentials(page)) return true;
    throw new Error('로그인이 필요합니다. 설정 화면에서 코레일 아이디·비밀번호를 입력하거나 .env에 KORAIL_ID/KORAIL_PW를 넣으세요. (node watch.js --login 으로 수동 로그인도 가능)');
  };

  const waitForManualLogin = async (page) => {
    const current = await loginStatus(page);
    if (current.loggedIn) {
      log('[로그인] 이미 로그인되어 있습니다 ✔');
      return;
    }
    await page.goto('https://www.korail.com/ticket/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    log(`[로그인] Chrome 창에서 로그인해주세요. 최대 ${config.loginTimeout / 1000}초 기다립니다.`);
    const deadline = Date.now() + config.loginTimeout;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      if ((await loginStatus(page)).loggedIn) {
        log('[로그인] 완료 — 전용 프로필에 세션이 저장되었습니다 ✔');
        return;
      }
    }
    throw new Error('수동 로그인 대기시간이 초과되었습니다.');
  };

  // ---------- 예열 ----------
  // raw fetch가 통과 상태인지 확인 (IRG000000이면 예열 완료)
  const verify = async (page) => isPrimed(await fetchSchedule(page, scheduleBody()));

  // dynaPath 예열 1회: 메인에서 조회 버튼 클릭 → SPA가 실제 조회를 수행하게 함
  const primeOnce = async (page) => {
    await page.goto('https://www.korail.com/ticket/main', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    // SPA의 ScheduleView 응답을 기다려 예열 완료 신호로 사용
    const settled = page.waitForResponse(r => /ScheduleView/i.test(r.url()), { timeout: 12000 }).catch(() => null);
    try { await page.getByText('열차 조회하기', { exact: false }).first().click({ timeout: 8000 }); }
    catch { /* 버튼 못 찾으면 그냥 대기 */ }
    await settled;
    await page.waitForTimeout(1500);
  };

  // 예열이 실제로 통과할 때까지 반복 (콜드 스타트 시 보통 1~2회 필요)
  const primeUntilReady = async (page, attempts = 5) => {
    for (let i = 1; i <= attempts; i++) {
      log(`[예열] dynaPath 신뢰 상태 확보 중... (${i}/${attempts})`);
      await primeOnce(page);
      if (await verify(page)) { log('[예열] 완료 ✔'); return true; }
    }
    warn('[예열] 실패 — 계속 차단 상태입니다.');
    return false;
  };

  // ---------- 좌석 ----------
  // selectable: true=웹에서 좌석선택 가능, false=선택 가능한 호차 없음,
  // null=통신/차단 오류라 판정 보류(기존 알림 상태도 유지)
  const hasSelectableSeats = async (page, train, seat) => {
    if (!seat.psrmClCd) return { selectable: true, carCount: null, cars: [] };

    let res = await fetchSeatMap(page, train, seat.psrmClCd);
    if (apiFailed(res)) {
      warn(`[좌석검증] ${train.h_trn_no} ${seat.label} 조회 오류 → 재예열`);
      if (await primeUntilReady(page, 3)) res = await fetchSeatMap(page, train, seat.psrmClCd);
    }
    if (apiFailed(res)) {
      const detail = apiErrorMessage(res).slice(0, 80);
      warn(`[좌석검증] ${train.h_trn_no} ${seat.label} 판정 보류: ${detail}`);
      return { selectable: null, carCount: null, cars: [] };
    }

    const cars = res.json.srcar_infos?.srcar_info;
    return {
      selectable: Array.isArray(cars) && cars.length > 0,
      carCount: Array.isArray(cars) ? cars.length : 0,
      cars: Array.isArray(cars) ? cars : [],
    };
  };

  const loadBestSeatOption = async (page, train, seat, cars) => {
    const numericCars = cars
      .map(car => ({ ...car, carNo: Number(car.h_srcar_no) }))
      .filter(car => Number.isFinite(car.carNo));
    if (!numericCars.length) return null;
    const midpoint = (Math.min(...numericCars.map(car => car.carNo))
      + Math.max(...numericCars.map(car => car.carNo))) / 2;
    numericCars.sort((a, b) => Math.abs(a.carNo - midpoint) - Math.abs(b.carNo - midpoint));

    const carSeatMaps = [];
    for (const car of numericCars) {
      let res = await fetchSeatList(page, train, seat.psrmClCd, car.carNo);
      if (apiFailed(res)) {
        warn(`[좌석선택] ${train.h_trn_no} ${car.carNo}호차 상세 조회 실패 → 재예열`);
        if (await primeUntilReady(page, 2)) res = await fetchSeatList(page, train, seat.psrmClCd, car.carNo);
      }
      if (apiFailed(res)) continue;
      carSeatMaps.push({
        carNo: car.carNo,
        seats: (res.json.seatList || []).map(item => ({ ...item, srcarNo: car.carNo })),
      });
    }

    return chooseBestSeatOption(carSeatMaps, {
      adults: config.adults,
      children: config.children,
      infants: config.infants,
      seniors: config.seniors,
    });
  };

  // ---------- 예약 ----------
  const reserveSelectedSeats = async (page, train, seat, option) => {
    const body = buildReservationBody({
      train,
      seatClassCode: seat.psrmClCd,
      seats: option.seats.map(selected => ({ ...selected, srcarNo: selected.srcarNo || option.carNo })),
      passengers: {
        adults: config.adults,
        children: config.children,
        infants: config.infants,
        seniors: config.seniors,
      },
      date: config.date,
    });
    let res = await fetchKorailApi(page, ENDPOINTS.reservation, body);
    if (sessionExpired(res)) {
      warn('[예약] 로그인 세션이 만료되어 다시 로그인합니다.');
      await ensureLoggedIn(page);
      res = await fetchKorailApi(page, ENDPOINTS.reservation, body);
    }
    if (reservationFailed(res)) throw new Error(apiErrorMessage(res));
    return res.json;
  };

  const notifyReservationComplete = async (train, seat, option, data) => {
    const { message, summary } = buildReservationMessage({
      from: config.from, to: config.to, dateLabel: config.dateLabel, train, seat, option, data,
    });
    log(`  → 예약 완료: ${summary}`);
    events.emit('reserved', { train, seat, option, reservation: data, message, summary });
    await sendTelegram(message);
  };

  /** 예약 시도. 감시를 끝내야 하면 종료 결과를, 계속 돌아도 되면 null을 돌려준다. */
  const tryReserve = async (page, train, name, seat, cars) => {
    const option = await loadBestSeatOption(page, train, seat, cars);
    if (!option) return null;
    const specs = option.seats.map(item => item.seat_spec).join(', ');
    log(`[좌석선택] ${name} ${seat.label} → ${option.carNo}호차 ${specs} | 인접쌍 ${option.metrics.pairCount} | 순방향 ${option.metrics.forwardCount} | 4인동반석 ${option.metrics.fourFacingCount}`);
    if (config.dryRunReserve) return { reserved: false, dryRun: true, option };
    try {
      const reservation = await reserveSelectedSeats(page, train, seat, option);
      await notifyReservationComplete(train, seat, option, reservation);
      return { reserved: true, reservation, train, seat, option };
    } catch (error) {
      warn(`[예약] ${name} ${seat.label} 실패: ${error.message}`);
      if (/로그인이 필요|KORAIL_(?:ID|PW|MEMBER)|\[로그인\] 실패/.test(error.message)) {
        await sendTelegram(`<b>⚠️ 코레일 자동 예약 중단</b>\n로그인 갱신 실패: ${escapeHtml(error.message)}\n\n다시 로그인한 뒤 감시를 재시작하세요.`);
        return { reserved: false, fatal: true, error };
      }
      // 응답 자체를 받지 못했다면 예약 성공 여부가 불명확하므로 중복 예약을
      // 피하기 위해 자동 재시도하지 않고 감시를 멈춘다.
      if (/page\.evaluate|fetch|network|통신/i.test(error.message)) {
        await sendTelegram(`<b>⚠️ 코레일 예약 결과 확인 필요</b>\n${escapeHtml(name)} 예약 요청 중 응답이 끊겼습니다.\n중복 예약 방지를 위해 감시를 중단했습니다. 코레일 예약내역을 직접 확인하세요.`);
        return { reserved: false, fatal: true, error };
      }
      return null;
    }
  };

  // ---------- 한 주기 ----------
  const cycle = async (page) => {
    const body = scheduleBody();
    let res = await fetchSchedule(page, body);
    // 토큰 만료/차단 시 재예열 후 재시도
    if (apiFailed(res)) {
      warn('[감시] 신뢰 상태 만료 → 재예열');
      await primeUntilReady(page, 3);
      res = await fetchSchedule(page, body);
    }
    if (apiFailed(res)) {
      warn(`[감시] 조회 실패(다음 주기 재시도): ${apiErrorMessage(res).slice(0, 80)}`);
      return { reserved: false };
    }
    const allTrains = res.json.trn_infos?.trn_info || [];
    // 출발시각 범위 필터 (--time ~ --time-to)
    const trains = allTrains.filter(train => withinDepartureRange(train, config));
    const clock = now().toLocaleTimeString('ko-KR');
    const hits = [];
    const statusLine = [];
    for (const train of trains) {
      const no = train.h_trn_no;
      if (config.trains && !config.trains.includes(no)) continue;
      const name = `${train.h_trn_clsf_nm || 'KTX'} ${no}`;
      const candidates = availableSeats(train, config.seatClass);
      const seats = [];
      let verificationUnknown = false;
      for (const seat of candidates) {
        const verified = await hasSelectableSeats(page, train, seat);
        if (verified.selectable === true) {
          const selectable = { ...seat, carCount: verified.carCount, cars: verified.cars };
          seats.push(selectable);
          if (config.reserve || config.dryRunReserve) {
            const outcome = await tryReserve(page, train, name, selectable, verified.cars);
            if (outcome) return outcome;
          }
        }
        if (verified.selectable === null) verificationUnknown = true;
      }
      const marker = statusMarker({
        selectableCount: seats.length,
        candidateCount: candidates.length,
        verificationUnknown,
      });
      statusLine.push(`${no}:${marker}`);
      for (const seat of seats) {
        if (alerts.claim(no, seat.label)) {
          hits.push({ name, no, dep: train.h_dpt_tm_qb, arv: train.h_arv_tm_qb, label: seat.label,
            carCount: seat.carCount, seatSelectable: !!seat.psrmClCd,
            price: (train.h_rsv_psb_nm || '').split('\n')[0] });
        }
      }
      // 매진 또는 좌석조합 불가로 바뀌면 등급별 알림을 해제한다.
      // 검증 자체가 실패한 경우에는 상태를 보류해 중복 알림을 막는다.
      if (!verificationUnknown) alerts.release(no, seats.map(seat => seat.label));
    }
    const rangeLabel = departureRangeLabel(config.timeLabel, config.timeToLabel);
    const statusText = `[${clock}] ${config.from}→${config.to} ${config.date} ${rangeLabel} | 대상 ${trains.length}/${allTrains.length}개 | ${statusLine.join(' ')}`;
    log(statusText);
    events.emit('status', {
      clock, rangeLabel, text: statusText, markers: statusLine,
      targetCount: trains.length, totalCount: allTrains.length,
    });

    if (hits.length) {
      const message = buildVacancyMessage({
        from: config.from, to: config.to, dateLabel: config.dateLabel, rangeLabel, hits,
      });
      const action = config.telegram ? '텔레그램 전송' : '콘솔 알림(--no-telegram)';
      log(`  → 공석! ${action}: ${hits.map(hit => `${hit.name}(${hit.label})`).join(', ')}`);
      events.emit('found', { hits, message, rangeLabel });
      await sendTelegram(message);
    }
    return { reserved: false };
  };

  // ---------- 실행 ----------
  const announce = () => {
    if (config.loginOnly) { log('=== 코레일 로그인 세션 준비 ==='); return; }
    const rangeLabel = config.timeToLabel ? `${config.timeLabel}~${config.timeToLabel}` : `${config.timeLabel} 이후`;
    const mode = config.reserve ? '자동 예약' : config.dryRunReserve ? '예약 시뮬레이션' : '알림 감시';
    log(`=== 코레일 공석 감시 시작 (${mode}) ===`);
    log(`조건: ${config.from}→${config.to} ${config.dateLabel} ${rangeLabel} | 어른${config.adults} 어린이${config.children} 유아${config.infants} 경로${config.seniors} | 좌석:${config.seatClass} | 주기:${config.interval / 1000}s`);
    const account = creds.hasKorailLogin ? creds.korailId : '없음(저장된 세션/수동 로그인)';
    const notify = config.telegram ? `텔레그램 ${(creds.telegramChatIds ?? []).length}곳` : '터미널만';
    log(`계정: ${account} | 알림: ${notify}`);
    if (config.reserve) log('안전장치: 첫 예약 1건이 성공하면 즉시 감시를 종료합니다. 결제는 자동으로 진행하지 않습니다.');
    for (const warning of config.warnings ?? []) warn(`[경고] ${warning}`);
  };

  // 두 번 닫아도 안전해야 한다. 정상 종료와 Ctrl+C가 동시에 들어올 수 있다.
  const closeSession = async () => {
    if (!session || sessionClosed) return;
    sessionClosed = true;
    try { await session.close(); } catch {}
  };

  const finish = async (code, reason, { quiet = false } = {}) => {
    if (!quiet) log('\n종료 중...');
    await closeSession();
    const outcome = { code, reason };
    events.emit('end', outcome);
    return outcome;
  };

  const start = async () => {
    try {
      announce();
      session = await openSession({ config, log });
      const { page } = session;

      if (config.loginOnly) {
        await waitForManualLogin(page);
        return await finish(0, 'login', { quiet: true });
      }

      await primeUntilReady(page);
      if (config.reserve) {
        await ensureLoggedIn(page);
        // 자동 로그인 과정에서 로그인 화면으로 이동했을 수 있으므로 다시 예열한다.
        await primeUntilReady(page);
      }

      while (!stopped) {
        let result;
        try {
          result = await cycle(page);
        } catch (error) {
          warn(`[cycle 오류] ${error.message}`);
          result = { reserved: false };
        }
        if (result?.reserved) return await finish(0, 'reserved');
        if (result?.fatal) return await finish(2, 'fatal');
        if (config.once) return await finish(0, 'once');
        if (stopped) break;
        await sleep(config.interval);
      }
      return await finish(0, 'stopped');
    } catch (error) {
      events.emit('error', { error });
      await closeSession();
      const outcome = { code: 1, reason: 'error', error };
      events.emit('end', outcome);
      return outcome;
    }
  };

  const stop = () => {
    stopped = true;
    wake?.();
  };

  return {
    start,
    stop,
    close: closeSession,
    on: (event, handler) => { events.on(event, handler); return events; },
    off: (event, handler) => events.off(event, handler),
    once: (event, handler) => events.once(event, handler),
    events,
    get stopped() { return stopped; },
  };
};
