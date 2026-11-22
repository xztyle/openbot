import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/notification";

export const messages = {
  "notification.needsInput": "Нужен ваш ответ.",
  "notification.needsApproval": "Нужно ваше подтверждение.",
  "notification.needsBrowserStep": "Нужно, чтобы вы завершили шаг в браузере.",
  "notification.needsApprovalFor": "Нужно ваше подтверждение: {action}",
  "notification.finished": "Работа завершена.",
  // A workflow step that waits for a person to approve or reject it.
  "notification.workflowApproval": "Шаг ждет вашего одобрения.",
  // A workflow output step that tells the user its result.
  "notification.workflowOutput": "У рабочего процесса есть новый результат.",
  "notification.failed": "Остановлено из-за ошибки.",
  "notification.channelTitle": "{agent} в канале {channel}",
  "notification.teammateTitle": "{agent}: {teammate} ждёт вас",
  "notification.channelMessage": "Новое сообщение.",
  "notification.conversationTitle": "{author} в {conversation}",
  "notification.mentionedYou": "Упомянул(а) вас.",
  "notification.directMessage": "Отправил(а) вам сообщение.",
  "notification.threadReply": "Ответил(а) в ветке, за которой вы следите.",
  "notification.newMessages": {
    one: "{count} новое сообщение.",
    few: "{count} новых сообщения.",
    many: "{count} новых сообщений.",
    other: "{count} нового сообщения.",
  },
  "notification.usageLimit.title": "Аккаунт {provider} достиг лимита",
  "notification.usageLimit.body": {
    one: "Ждёт {count} агент. Atelier попробует позже.",
    few: "Ждут {count} агента. Atelier попробует позже.",
    many: "Ждут {count} агентов. Atelier попробует позже.",
    other: "Ждут {count} агента. Atelier попробует позже.",
  },
  "notification.usageLimit.bodyResets": {
    one: "Ждёт {count} агент. Сброс {reset}.",
    few: "Ждут {count} агента. Сброс {reset}.",
    many: "Ждут {count} агентов. Сброс {reset}.",
    other: "Ждут {count} агента. Сброс {reset}.",
  },
  "notification.test": "Уведомления работают.",
  "notification.welcome": "Atelier сообщит здесь, когда вы понадобитесь агенту.",
  "notification.toast.region": "Уведомления",
  "notification.toast.close": "Закрыть уведомление",
  "notification.digest.title": {
    one: "{count} обновление от ваших агентов",
    few: "{count} обновления от ваших агентов",
    many: "{count} обновлений от ваших агентов",
    other: "{count} обновления от ваших агентов",
  },
  "notification.digest.fromOne": "От {agent}.",
  "notification.digest.fromMany": {
    one: "От {agent} и ещё {count}.",
    few: "От {agent} и ещё {count}.",
    many: "От {agent} и ещё {count}.",
    other: "От {agent} и ещё {count}.",
  },
} as const satisfies PartialTranslation<typeof source>;
