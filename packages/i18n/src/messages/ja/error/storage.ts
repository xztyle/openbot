import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  // Storage errors.
  "error.storage.unsupported": "このサーバーはストレージに対応していません。",
  "error.storage.agentMissing": "エージェントが存在しません。",
  "error.storage.unreadableFile": "OpenBot は {path} を読み取れません。ファイルが破損しています。",
  "error.storage.hygieneUnsupported": "このサーバーはストレージのクリーンアップに対応していません。",
  "error.storage.hygieneBusy":
    "ストレージのスキャンまたはクリーンアップを実行中です。完了してからもう一度お試しください。",
  "error.storage.hygieneNoReport": "クリーンアップする前にストレージをスキャンしてください。",
} as const satisfies PartialTranslation<typeof source>;
