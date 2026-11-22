import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/insight";

export const messages = {
  "insight.costs.side": "보조 호출",
  "insight.costs.idle": "답장 없는 작업",
  "insight.costs.sortBy.idle": "답장 없는 작업",
  "insight.costs.sortBy.side": "보조 호출",
  "insight.costs.note":
    "에이전트 작업의 API 정가이며 요금제 청구액이 아니에요. 보조 호출은 작업 주변의 작은 확인이에요: 누가 답할지, 짧은 요약, 메모리 검토. 답장 없는 작업: 비용이 들었지만 메시지를 남기지 않은 턴이에요(파일이나 티켓은 바꿨을 수 있어요).",
  "insight.costs.line": "{turns}턴 · 토큰 {tokens} · 보조 {side}",
  "insight.briefing.alertRule": "에이전트가 돈을 쓰는데 판매가 없으면 알려 줘요",
  "insight.briefing.alertMinSpend": "초과 금액(US$)",
  "insight.briefing.alertDays": "이 기간(일)",
} as const satisfies PartialTranslation<typeof source>;
