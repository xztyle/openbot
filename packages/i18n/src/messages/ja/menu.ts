import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/menu";

export const messages = {
  "menu.stopAllAgents": "すべてのエージェントを停止",
  "menu.checkForUpdates": "アップデートを確認…",
  "menu.preferences": "設定…",
  "menu.actualSize": "実際のサイズ",
  "menu.zoomIn": "拡大",
  "menu.zoomOut": "縮小",
  "menu.copyLink": "リンクをコピー",
  "menu.trayOpen": "Atelier を開く",
  "menu.trayQuit": "Atelier を終了",
  "menu.trayTooltip": "Atelier",
} as const satisfies PartialTranslation<typeof source>;
