/**
 * 텔레그램 전송. 실패해도 감시는 계속돼야 하므로 예외를 밖으로 던지지 않고
 * 경고 문구만 흘려보낸다. 어디에 찍을지는 warn 콜백을 준 쪽이 정한다.
 */

export const createTelegramSender = ({
  enabled = true,
  token = '',
  chatIds = [],
  warn = () => {},
  fetchImpl = fetch,
} = {}) => async (text) => {
  if (!enabled) return;
  if (!token || !chatIds.length) {
    warn('[텔레그램] 봇 토큰/대화 ID 없음 (설정 화면 또는 .env 확인)');
    return;
  }
  for (const id of chatIds) {
    try {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: id, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      });
      const body = await response.json();
      if (!body.ok) warn(`[텔레그램] 전송 실패 chat=${id}: ${body.description}`);
    } catch (error) {
      warn(`[텔레그램] 오류: ${error.message}`);
    }
  }
};
