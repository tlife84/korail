/**
 * .env 파일과 프로세스 환경변수에서 코레일 계정·텔레그램 설정을 하나로 합친다.
 *
 * 설정 화면(launcher)은 입력값을 자식 프로세스의 환경변수로 넘긴다.
 * 명령줄 인자로 넘기지 않는 이유: 인자는 작업 관리자·명령어 미리보기에 그대로 노출된다.
 * 화면에서 넘어온 값임을 알리는 KORAIL_UI_CREDENTIALS=1 이 붙으면 .env 파일은 무시한다.
 * (화면에서 비워둔 칸은 "쓰지 않겠다"는 뜻이므로 .env 값이 되살아나면 안 된다.)
 */
import { existsSync, readFileSync } from 'node:fs';

export const UI_SOURCE_FLAG = 'KORAIL_UI_CREDENTIALS';

export const parseEnvFile = text => {
  const env = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (!match) continue;
    const quoted = match[2].match(/^(['"])(.*)\1$/);
    // 따옴표로 감싸지 않은 값은 공백 뒤의 # 부터를 줄 끝 주석으로 잘라낸다.
    env[match[1]] = quoted ? quoted[2] : match[2].replace(/\s+#.*$/, '').trim();
  }
  return env;
};

export const readEnvFile = path => (existsSync(path) ? parseEnvFile(readFileSync(path, 'utf8')) : {});

export const splitChatIds = value => String(value ?? '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

const KOREAN_LABELS = {
  korailId: '코레일 아이디',
  korailPw: '코레일 비밀번호',
  telegramToken: '텔레그램 봇 토큰',
  telegramChatIds: '텔레그램 대화 ID',
};

const FIELD_KEYS = {
  korailId: ['KORAIL_ID', 'KORAIL_MEMBER_ID'],
  korailPw: ['KORAIL_PW', 'KORAIL_PASSWORD'],
  telegramToken: ['TELEGRAM_BOT_TOKEN'],
  telegramChatIds: ['TELEGRAM_CHAT_IDS', 'TELEGRAM_ADMIN_CHAT_ID'],
};

/** 프로세스 환경변수 > .env 파일 순으로 값을 고른다. */
export const resolveCredentials = (processEnv = {}, fileEnv = {}) => {
  const uiOnly = String(processEnv[UI_SOURCE_FLAG] ?? '') === '1';
  const sources = {};
  const pick = field => {
    for (const key of FIELD_KEYS[field]) {
      const value = String(processEnv[key] ?? '').trim();
      if (value) { sources[field] = uiOnly ? 'ui' : 'env'; return value; }
    }
    if (!uiOnly) {
      for (const key of FIELD_KEYS[field]) {
        const value = String(fileEnv[key] ?? '').trim();
        if (value) { sources[field] = 'file'; return value; }
      }
    }
    sources[field] = 'none';
    return '';
  };

  const korailId = pick('korailId');
  const korailPw = pick('korailPw');
  const telegramToken = pick('telegramToken');
  const telegramChatIds = splitChatIds(pick('telegramChatIds'));
  return {
    korailId,
    korailPw,
    telegramToken,
    telegramChatIds,
    sources,
    hasKorailLogin: !!(korailId && korailPw),
    hasTelegram: !!(telegramToken && telegramChatIds.length),
  };
};

const validateToken = value => {
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(value)) {
    throw new Error('텔레그램 봇 토큰 형식이 올바르지 않습니다. 예: 123456789:AA...');
  }
};

const validateChatIds = ids => {
  for (const id of ids) {
    if (!/^-?\d{1,20}$/.test(id) && !/^@[A-Za-z][A-Za-z0-9_]{3,}$/.test(id)) {
      throw new Error(`텔레그램 대화 ID가 올바르지 않습니다: ${id} (숫자 또는 @채널이름)`);
    }
  }
};

/** 설정 화면 입력값을 검증해 watch.js 에 넘길 환경변수로 만든다. */
export const buildCredentialEnv = (input = {}) => {
  const text = field => String(input[field] ?? '').trim();
  const korailId = text('korailId');
  const korailPw = text('korailPw');
  const telegramToken = text('telegramToken');
  const chatIds = splitChatIds(input.telegramChatIds);

  if (!!korailId !== !!korailPw) {
    const missing = korailId ? KOREAN_LABELS.korailPw : KOREAN_LABELS.korailId;
    throw new Error(`${missing}도 함께 입력하세요. 둘 다 비워두면 자동 로그인을 사용하지 않습니다.`);
  }
  if (/\s/.test(korailId)) throw new Error('코레일 아이디에 공백을 넣을 수 없습니다.');
  if (telegramToken) validateToken(telegramToken);
  if (chatIds.length) validateChatIds(chatIds);
  if (!!telegramToken !== !!chatIds.length) {
    const missing = telegramToken ? KOREAN_LABELS.telegramChatIds : KOREAN_LABELS.telegramToken;
    throw new Error(`${missing}도 함께 입력하세요. 둘 다 비워두면 텔레그램 없이 콘솔에만 출력합니다.`);
  }

  return {
    [UI_SOURCE_FLAG]: '1',
    KORAIL_ID: korailId,
    KORAIL_PW: korailPw,
    TELEGRAM_BOT_TOKEN: telegramToken,
    TELEGRAM_CHAT_IDS: chatIds.join(','),
  };
};

/** 실행을 막지는 않지만 화면과 터미널에 보여줄 경고 문구. */
export const credentialWarnings = ({ hasKorailLogin, hasTelegram }, { reserve = false } = {}) => {
  const warnings = [];
  if (!hasKorailLogin) {
    warnings.push(reserve
      ? '코레일 아이디·비밀번호가 없습니다. 전용 Chrome에 저장된 로그인 세션이 없으면 예약이 실패합니다. (node watch.js --login 으로 수동 로그인)'
      : '코레일 아이디·비밀번호가 없습니다. 자동 로그인과 좌석선택 예약을 사용할 수 없습니다.');
  }
  if (!hasTelegram) warnings.push('텔레그램 봇 토큰·대화 ID가 없습니다. 알림 없이 터미널에만 출력합니다.');
  return warnings;
};
