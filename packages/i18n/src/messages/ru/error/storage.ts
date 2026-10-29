import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  "error.storage.unsupported": "Этот сервер не поддерживает хранилище.",
  "error.storage.agentMissing": "Агента не существует.",
  "error.storage.unreadableFile": "OpenBot не может прочитать {path}. Файл повреждён.",
  "error.storage.hygieneUnsupported": "Этот сервер не поддерживает очистку хранилища.",
  "error.storage.hygieneBusy": "Идёт проверка или очистка хранилища. Повторите попытку, когда она завершится.",
  "error.storage.hygieneNoReport": "Проверьте хранилище перед очисткой.",
} as const satisfies PartialTranslation<typeof source>;
