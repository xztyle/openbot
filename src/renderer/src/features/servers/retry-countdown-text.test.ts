import { loadLocale, translateFor } from "@openbot/i18n";
import { describe, expect, it } from "vitest";

// Failure mode: the reconnect countdown reaches "Next attempt in 1 seconds" ("1 segundos").
describe("the reconnect countdown", () => {
  it("says one second in the singular", async () => {
    expect(translateFor("en")("server.connection.nextRetry", { count: 1 })).toBe("Next attempt in 1 second.");
    expect(translateFor("en")("server.connection.nextRetry", { count: 5 })).toBe("Next attempt in 5 seconds.");
    await loadLocale("es");
    expect(translateFor("es")("server.connection.nextRetry", { count: 1 })).toBe("Próximo intento en 1 segundo.");
  });
});
