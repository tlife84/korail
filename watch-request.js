/**
 * 설정 화면 입력 → 감시 엔진에 넘길 재료.
 *
 * HTTP 런처(launcher.js)는 이 재료로 watch.js를 자식 프로세스로 띄우고,
 * Electron 셸은 같은 재료로 엔진을 제자리에서 돌린다. 두 경로가 같은 검증을
 * 타도록 여기 한 곳에 모아뒀다. Electron도 node도 모르는 순수 함수라 테스트가 쉽다.
 */
import { buildWatchArgs, formatWatchCommand } from './launcher-options.js';
import { buildCredentialEnv, resolveCredentials } from './env-config.js';
import { parseArgs, buildWatchConfig } from './watch-config.js';

/**
 * 성공하면 { args, command, config, creds, credentialEnv, warnings },
 * 입력이 잘못됐으면 { error } 하나만 돌려준다.
 */
export const buildRunRequest = (input = {}) => {
  try {
    const args = buildWatchArgs(input);
    // 비밀번호·토큰은 명령줄 인자가 아니라 환경변수로 넘긴다.
    // 인자는 작업 관리자와 명령어 미리보기에 그대로 노출된다.
    const credentialEnv = buildCredentialEnv(input);
    const creds = resolveCredentials(credentialEnv);
    const { config, error } = buildWatchConfig(parseArgs(args), creds);
    if (error) return { error };
    return {
      args,
      command: formatWatchCommand(args),
      config,
      creds,
      credentialEnv,
      warnings: config.warnings,
    };
  } catch (error) {
    return { error: error.message };
  }
};
