import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/insight";

export const messages = {
  "insight.costs.side": "補助呼び出し",
  "insight.costs.idle": "返信のない作業",
  "insight.costs.sortBy.idle": "返信のない作業",
  "insight.costs.sortBy.side": "補助呼び出し",
  "insight.costs.note":
    "エージェントの作業の API 定価で、プランの請求額ではありません。補助呼び出しは作業まわりの小さな確認です（誰が答えるか、短い要約、メモリの見直し）。返信のない作業：費用がかかったのにメッセージを残さなかったターン（ファイルやチケットは変えている場合があります）。",
  "insight.costs.line": "{turns} ターン · {tokens} トークン · 補助 {side}",
} as const satisfies PartialTranslation<typeof source>;
