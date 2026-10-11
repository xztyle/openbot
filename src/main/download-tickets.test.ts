import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DOWNLOAD_TICKET_LIFETIME_MS, DownloadTickets } from "./download-tickets";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

// The same key, path, name and time are in `scripts/download-gateway/test_downloadd.py`. The gateway
// must accept this exact token, so the two implementations cannot drift apart unnoticed.
const KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const NOW = 1_800_000_000_000;
const TOKEN =
  "eyJ2IjoxLCJwIjoiL2RhdGEvT3BlbkJvdC9TaGFyZWQvVHJhbnNmZXJzL2ZpbmFsLm1vdiIsIm4iOiJmaW5hbC5tb3YiLCJlIjoxODAwMDAwOTAwMDAwfQ" +
  ".3mFa2iVOmRpE_zwP1FJkJPoYMzQyrsuCL6vVIMP27lY";

async function tickets(baseUrl: string | null) {
  const root = await mkdtemp(join(tmpdir(), "openbot-tickets-"));
  roots.push(root);
  await writeFile(join(root, "key"), KEY);
  if (baseUrl !== null) await writeFile(join(root, "base"), `${baseUrl}\n`);
  return new DownloadTickets({ keyPath: join(root, "key"), baseUrlPath: join(root, "base"), now: () => NOW });
}

describe("download tickets", () => {
  it("signs the path, name and expiry with the key file", async () => {
    const minted = (await tickets("https://dl.example.com")).mint({
      path: "/data/OpenBot/Shared/Transfers/final.mov",
      name: "final.mov",
    });
    expect(minted?.expiresAt).toBe(NOW + DOWNLOAD_TICKET_LIFETIME_MS);
    const token = minted?.url.replace("https://dl.example.com/d/", "") ?? "";
    const [payload = "", signature = ""] = token.split(".");
    expect(signature).toBe(createHmac("sha256", KEY).update(payload).digest("base64url"));
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toEqual({
      v: 1,
      p: "/data/OpenBot/Shared/Transfers/final.mov",
      n: "final.mov",
      e: NOW + DOWNLOAD_TICKET_LIFETIME_MS,
    });
    expect(token).toBe(TOKEN);
  });

  it("makes no ticket without a valid download address", async () => {
    const file = { path: "/data/OpenBot/a.txt", name: "a.txt" };
    expect((await tickets(null)).mint(file)).toBeNull();
    expect((await tickets("http://dl.example.com")).mint(file)).toBeNull();
    expect((await tickets("https://dl.example.com/path")).mint(file)).toBeNull();
  });
});
