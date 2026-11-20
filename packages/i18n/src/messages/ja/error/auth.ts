import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/auth";

export const messages = {
  // Errors from the OpenBot account service.
  "error.auth.serviceUnavailable":
    "Atelier がアカウントサービスに接続できませんでした。API が動作していることを確認してから、再試行してください。",
  "error.auth.networkBlocked":
    "このネットワークのファイアウォールまたはプロキシが、Atelier から {host} への接続をブロックしました。ネットワーク管理者に {host} の許可を依頼してから、再試行してください。",
  "error.auth.signInFirst": "先に Atelier にサインインしてください。",
  "error.auth.signInRequired": "サインインが必要です。",
  "error.auth.accountChangedDuringRegister": "このサーバーの登録中に、サインイン中のアカウントが変わりました。",
  "error.auth.hostCredentialUnavailable": "リモートホストの認証情報を利用できません。ホストを再登録してください。",
  "error.auth.codeNotVerified": "サインインコードを確認できませんでした。",
  "error.auth.serviceError": "アカウントサービスがエラーを返しました。",
  "error.auth.serviceUnreachable":
    "Atelier はアカウントサービスに接続できませんでした。接続を確認してから、もう一度お試しください。",
  "error.auth.serviceTimeout": "アカウントサービスが時間内に応答しませんでした。もう一度お試しください。",
  "error.auth.serviceStatus": "アカウントサービスがエラー ({status}) を返しました。後でもう一度お試しください。",
  "error.auth.invalidHostedServer": "アカウントサービスが無効なホスト型サーバーを返しました。",
  "error.auth.codeNotSent": "Atelier がサインインコードを送信できませんでした。",
  "error.auth.deliveryTimeout":
    "Atelier が時間内に配信を確認できませんでした。コードが後で届く場合があります。再送信する前に配信を確認してください。",
  "error.auth.deliveryInterrupted":
    "Atelier が配信を確認する前に接続が終了しました。別のコードを送信しないように、配信を確認してください。",
  "error.auth.deliveryUnknown":
    "サインインコードが送信されたかどうかを Atelier が確認できませんでした。再送信する前に配信を確認してください。",
} as const satisfies PartialTranslation<typeof source>;
