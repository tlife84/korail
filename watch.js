#!/usr/bin/env node
/**
 * korail-watch — 코레일 공석 감시 → 텔레그램 알림 (CLI)
 *
 * 실제 감시는 watcher.js가 한다. 여기서는 인자를 읽어 설정을 만들고,
 * 엔진이 흘려보내는 이벤트를 터미널에 찍고, 종료 코드를 정하는 일만 한다.
 *
 * 코레일(korail.com)은 dynaPath 안티매크로로 보호되어 순수 HTTP 요청은 차단된다.
 * 그래서 진짜 Chrome을 원격 디버깅으로 띄워 그 컨텍스트 안에서 조회한다(chrome.js).
 *
 * 사용 예:
 *   node watch.js --date 2026-07-17 --time 12:00 --from 광명 --to 서대전 \
 *                 --adults 1 --infants 1 --interval 60
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readEnvFile, resolveCredentials } from './env-config.js';
import { parseArgs, buildWatchConfig, HELP } from './watch-config.js';
import { createWatcher } from './watcher.js';

const projectDir = dirname(fileURLToPath(import.meta.url));

const args = parseArgs(process.argv.slice(2));
if (args.help) { console.log(HELP); process.exit(0); }

// 설정 화면에서 넘어온 환경변수가 있으면 그 값을, 없으면 .env 파일 값을 쓴다.
const creds = resolveCredentials(process.env, readEnvFile(resolve(projectDir, '.env')));

const { config, error } = buildWatchConfig(args, creds);
if (error) { console.error(error); process.exit(1); }

const watcher = createWatcher({ config, creds });

const CONSOLE = { info: console.log, warn: console.warn, error: console.error };
watcher.on('log', ({ level, text }) => (CONSOLE[level] ?? console.log)(text));
watcher.on('error', ({ error: failure }) => console.error('치명적 오류:', failure.message || failure));

let interrupted = false;
const interrupt = async () => {
  // Ctrl+C는 진행 중인 주기를 기다리지 않는다. 크롬을 닫고 바로 나간다.
  if (interrupted) process.exit(0);
  interrupted = true;
  watcher.stop();
  console.log('\n종료 중...');
  await watcher.close();
  process.exit(0);
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

const { code } = await watcher.start();
process.exit(code);
