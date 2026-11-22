import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/insight";

export const messages = {
  "insight.costs.side": "辅助调用",
  "insight.costs.idle": "无回复的工作",
  "insight.costs.sortBy.idle": "无回复的工作",
  "insight.costs.sortBy.side": "辅助调用",
  "insight.costs.note":
    "智能体工作的 API 标价，不是你的套餐费用。辅助调用是工作周边的小检查：由谁回答、简短摘要和记忆复查。无回复的工作：产生了费用却没有留下消息的回合（它们可能仍修改了文件或工单）。",
  "insight.costs.line": "{turns} 回合 · {tokens} 个 token · 辅助 {side}",
  "insight.briefing.alertRule": "当智能体花钱却没有销售时提醒我",
  "insight.briefing.alertMinSpend": "超过（美元）",
  "insight.briefing.alertDays": "持续天数",
} as const satisfies PartialTranslation<typeof source>;
