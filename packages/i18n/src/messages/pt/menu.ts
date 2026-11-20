import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/menu";

export const messages = {
  "menu.stopAllAgents": "Parar todos os agentes",
  "menu.checkForUpdates": "Buscar atualizações…",
  "menu.preferences": "Configurações…",
  "menu.actualSize": "Tamanho real",
  "menu.zoomIn": "Ampliar",
  "menu.zoomOut": "Reduzir",
  "menu.copyLink": "Copiar link",
  "menu.trayOpen": "Abrir o Atelier",
  "menu.trayQuit": "Sair do Atelier",
  "menu.trayTooltip": "Atelier",
} as const satisfies PartialTranslation<typeof source>;
