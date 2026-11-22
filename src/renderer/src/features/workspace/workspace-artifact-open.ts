import type { useWorkspace } from "./workspace-context";

/** Opens an artifact: its address, or the file an agent attached. */
export function openArtifact(ws: ReturnType<typeof useWorkspace>, id: string, channelId?: string) {
  const artifact = ws.artifacts.artifacts(channelId ? { channelId } : undefined).find((item) => item.id === id);
  if (artifact?.url) {
    void ws.channels.port().openUrl(artifact.url);
    return;
  }
  const file = ws.artifactRecord(id)?.file;
  const attachmentId = file?.id ?? (id.includes(":attachment:") ? id.split(":attachment:")[1] : undefined);
  if (attachmentId)
    void ws.channels
      .port()
      .agent.openAttachment({ attachmentId, action: "open" })
      .catch(() => undefined);
}
