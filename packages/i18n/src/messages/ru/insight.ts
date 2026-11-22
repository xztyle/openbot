import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/insight";

export const messages = {
  "insight.costs.side": "Вспомогательные вызовы",
  "insight.costs.idle": "Работа без ответа",
  "insight.costs.sortBy.idle": "Работа без ответа",
  "insight.costs.sortBy.side": "Вспомогательные вызовы",
  "insight.costs.note":
    "Цены API по прайсу за работу агентов, а не списания по вашему тарифу. Вспомогательные вызовы — небольшие проверки вокруг работы: кто должен ответить, короткие сводки и проверки памяти. Работа без ответа — ходы, которые стоили денег и не оставили сообщения (они могли изменить файлы или задачи).",
  "insight.costs.line": "Ходов: {turns} · токенов: {tokens} · вспомогательные {side}",
} as const satisfies PartialTranslation<typeof source>;
