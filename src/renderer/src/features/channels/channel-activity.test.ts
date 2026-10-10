import { channelActivitySentence } from "@openbot/ui/features/channels/ChannelActivityIndicator";
import { currentText } from "@openbot/ui/text";
import { describe, expect, it } from "vitest";

const sentence = (workers: Array<{ name: string; queued?: boolean }>) => {
  const { t, format } = currentText();
  return channelActivitySentence(workers, t, format);
};

describe("channelActivitySentence", () => {
  it("names who works and who is queued", () => {
    expect(sentence([{ name: "Ana" }, { name: "Bo" }, { name: "Cy", queued: true }])).toBe(
      "Ana and Bo are working · Cy queued",
    );
  });

  it("names one worker and several queued members", () => {
    expect(sentence([{ name: "Ana" }, { name: "Bo", queued: true }, { name: "Cy", queued: true }])).toBe(
      "Ana is working · Bo and Cy queued",
    );
  });

  it("names only the queue while nobody works, and only the workers when nothing waits", () => {
    expect(sentence([{ name: "Cy", queued: true }])).toBe("Cy queued");
    expect(sentence([{ name: "Ana" }])).toBe("Ana is working");
    expect(sentence([])).toBe("");
  });
});
