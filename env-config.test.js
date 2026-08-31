import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UI_SOURCE_FLAG,
  buildCredentialEnv,
  credentialWarnings,
  parseEnvFile,
  resolveCredentials,
  splitChatIds,
} from './env-config.js';

const TOKEN = '123456789:AAEhBOweik6ad9r-6ujKvHqAbcdefGhIjKl';

test('.env 파일에서 키=값을 읽고 줄 끝 주석은 잘라낸다', () => {
  const env = parseEnvFile([
    'TELEGRAM_BOT_TOKEN=123456:AA...',
    'TELEGRAM_CHAT_IDS = 111, 222        # 쉼표로 여러 명 가능',
    'KORAIL_PW="  따옴표 안은 그대로  "',
    'KORAIL_ID=1234#5678',
    '# 주석',
    '빈 줄 아님',
  ].join('\n'));

  assert.equal(env.TELEGRAM_BOT_TOKEN, '123456:AA...');
  assert.equal(env.TELEGRAM_CHAT_IDS, '111, 222');
  assert.equal(env.KORAIL_PW, '  따옴표 안은 그대로  ');
  assert.equal(env.KORAIL_ID, '1234#5678', '공백 없는 #은 값의 일부다');
  assert.equal(Object.keys(env).length, 4);
});

test('.env 값이 없으면 빈 값으로 남고 경고 대상이 된다', () => {
  const creds = resolveCredentials({}, {});
  assert.equal(creds.korailId, '');
  assert.equal(creds.hasKorailLogin, false);
  assert.equal(creds.hasTelegram, false);
  assert.deepEqual(creds.telegramChatIds, []);
  assert.equal(credentialWarnings(creds).length, 2);
});

test('.env 파일 값을 읽고 옛 키 이름도 인정한다', () => {
  const creds = resolveCredentials({}, {
    KORAIL_MEMBER_ID: '1234567890',
    KORAIL_PASSWORD: 'secret',
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_ADMIN_CHAT_ID: '556744257',
  });

  assert.equal(creds.korailId, '1234567890');
  assert.equal(creds.korailPw, 'secret');
  assert.deepEqual(creds.telegramChatIds, ['556744257']);
  assert.equal(creds.hasKorailLogin, true);
  assert.equal(creds.hasTelegram, true);
  assert.equal(creds.sources.korailId, 'file');
  assert.deepEqual(credentialWarnings(creds), []);
});

test('환경변수가 .env 파일보다 우선한다', () => {
  const creds = resolveCredentials({ KORAIL_ID: '화면입력' }, { KORAIL_ID: '파일값', KORAIL_PW: 'pw' });
  assert.equal(creds.korailId, '화면입력');
  assert.equal(creds.korailPw, 'pw');
  assert.equal(creds.sources.korailId, 'env');
});

test('설정 화면에서 넘어온 값은 .env 파일을 완전히 대체한다', () => {
  const fileEnv = { KORAIL_ID: '파일아이디', KORAIL_PW: 'pw', TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_IDS: '111' };
  const creds = resolveCredentials(
    { ...buildCredentialEnv({ korailId: '', korailPw: '', telegramToken: '', telegramChatIds: '' }) },
    fileEnv,
  );

  // 화면에서 비운 칸은 "쓰지 않겠다"는 뜻이므로 .env 값이 되살아나면 안 된다.
  assert.equal(creds.korailId, '');
  assert.equal(creds.hasKorailLogin, false);
  assert.equal(creds.hasTelegram, false);
  assert.equal(creds.sources.korailPw, 'none');
});

test('설정 화면 입력을 환경변수로 만든다', () => {
  const env = buildCredentialEnv({
    korailId: ' 1234567890 ',
    korailPw: ' secret ',
    telegramToken: ` ${TOKEN} `,
    telegramChatIds: '111, 222 ,',
  });

  assert.deepEqual(env, {
    [UI_SOURCE_FLAG]: '1',
    KORAIL_ID: '1234567890',
    KORAIL_PW: 'secret',
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_CHAT_IDS: '111,222',
  });
});

test('아무것도 입력하지 않아도 실행을 막지 않는다', () => {
  assert.deepEqual(buildCredentialEnv({}), {
    [UI_SOURCE_FLAG]: '1',
    KORAIL_ID: '',
    KORAIL_PW: '',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHAT_IDS: '',
  });
});

test('아이디와 비밀번호는 한쪽만 입력할 수 없다', () => {
  assert.throws(() => buildCredentialEnv({ korailId: '1234567890' }), /코레일 비밀번호도 함께/);
  assert.throws(() => buildCredentialEnv({ korailPw: 'secret' }), /코레일 아이디도 함께/);
});

test('토큰과 대화 ID도 한쪽만 입력할 수 없다', () => {
  assert.throws(() => buildCredentialEnv({ telegramToken: TOKEN }), /대화 ID도 함께/);
  assert.throws(() => buildCredentialEnv({ telegramChatIds: '111' }), /봇 토큰도 함께/);
});

test('잘못된 토큰과 대화 ID를 거부한다', () => {
  assert.throws(() => buildCredentialEnv({ telegramToken: 'abc', telegramChatIds: '111' }), /토큰 형식/);
  assert.throws(() => buildCredentialEnv({ telegramToken: TOKEN, telegramChatIds: '111, 이름' }), /대화 ID가 올바르지 않습니다/);
});

test('그룹(음수)과 채널(@이름) 대화 ID를 허용한다', () => {
  const env = buildCredentialEnv({ telegramToken: TOKEN, telegramChatIds: '-1001234567890,@korail_alert' });
  assert.equal(env.TELEGRAM_CHAT_IDS, '-1001234567890,@korail_alert');
  assert.deepEqual(splitChatIds(env.TELEGRAM_CHAT_IDS), ['-1001234567890', '@korail_alert']);
});

test('예약 모드에서는 계정 없음 경고가 더 강하게 나온다', () => {
  const creds = resolveCredentials({}, { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_IDS: '111' });
  const [warning] = credentialWarnings(creds, { reserve: true });
  assert.match(warning, /예약이 실패/);
  assert.equal(credentialWarnings(creds).length, 1);
});
