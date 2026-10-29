import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/storage";

export const messages = {
  // Storage errors.
  "error.storage.unsupported": "该服务器不支持存储功能。",
  "error.storage.agentMissing": "该助手不存在。",
  "error.storage.unreadableFile": "OpenBot 无法读取 {path}，该文件已损坏。",
  "error.storage.hygieneUnsupported": "该服务器不支持存储清理。",
  "error.storage.hygieneBusy": "存储扫描或清理正在进行。完成后再试一次。",
  "error.storage.hygieneNoReport": "请先扫描存储，再进行清理。",
} as const satisfies PartialTranslation<typeof source>;
