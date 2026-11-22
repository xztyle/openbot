import { describe, expect, it } from "vitest";
import { amountIn } from "./workspace-decisions";

// Failure mode: an approval that is not spend shows a dollar amount on Today and in Money, such as a
// shell command with "$1", or a peso amount written "$50.000" reads as fifty dollars.
describe("amountIn", () => {
  it("reads the host's money effect lines", () => {
    expect(amountIn("Hotmart · pay 19.00 USD · product X")).toBe(19);
    expect(amountIn("Meta ads · daily budget 10 USD → 50 USD · ad set 1203")).toBe(50);
    expect(amountIn("Meta ads · daily budget ? → 1,250 USD")).toBe(1250);
    expect(amountIn("Send the invoice (19.5 USD)")).toBe(19.5);
    expect(amountIn("Payment · pay 19 USD\nAfter you approve: pay 19 USD by hand at Hotmart.")).toBe(19);
  });

  it("gives no amount for a bare dollar sign or another currency", () => {
    expect(amountIn("awk '{print $1}' sales.csv")).toBeUndefined();
    expect(amountIn('git commit -m "Price $5"')).toBeUndefined();
    expect(amountIn("Hotmart · pay $50.000 COP")).toBeUndefined();
    expect(amountIn("Hotmart · pay 50000 COP · product X")).toBeUndefined();
    expect(amountIn("rm -rf build2USD")).toBeUndefined();
  });
});
