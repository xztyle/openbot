import { describe, expect, it } from "vitest";
import { classifyCommand, expandCommand } from "./trust-classifier";

const action = (command: string, scripts: Record<string, string> = {}) =>
  classifyCommand(command, { cwd: "/work", readScript: (path) => scripts[path] ?? null })?.action ?? null;

describe("the money check of a shell command", () => {
  it("keeps the plain rules", () => {
    expect(action(`curl -X POST https://api.stripe.com/v1/charges -d amount=500`)).toBe("pay");
    expect(action(`node "$M" set-budget 123 --daily 20 # meta-ads`)).toBe("launch_ads");
    expect(action(`curl https://api.stripe.com/v1/charges`)).toBeNull();
    expect(action(`ls -la && git status`)).toBeNull();
  });

  it("sees through a base64 payload piped to a shell", () => {
    const payload = Buffer.from("curl -X POST https://api.stripe.com/v1/payouts -d amount=9000").toString("base64");
    expect(action(`echo ${payload} | base64 -d | sh`)).toBe("pay");
  });

  it("sees through split strings and an inline interpreter", () => {
    expect(
      action(`python3 -c "import requests; requests.post('https://api.str' + 'ipe.com/v1/transfers', data={})"`),
    ).toBe("pay");
    expect(action(`c''url -X POST "https://graph.facebook.com/v21.0/act_1/ads" -d 'status=ACTIVE'`)).toBe("launch_ads");
    expect(action(`printf '\\x63url -X POST https://api.stripe.com/v1/refunds'`)).toBe("pay");
  });

  it("reads a script that the command runs", () => {
    const script = `import requests\nrequests.post("https://graph.facebook.com/v21.0/act_9/adsets", json={"daily_budget": 5000})\n`;
    expect(action(`python3 launch.py`, { "/work/launch.py": script })).toBe("launch_ads");
    expect(action(`python3 report.py`, { "/work/report.py": `print("hello")` })).toBeNull();
  });

  it("asks for a write next to a live payment key, and lets reads go", () => {
    expect(
      action(
        `node -e "fetch(u, {method: 'POST', headers: {Authorization: 'Bearer ' + process.env.STRIPE_SECRET_KEY}})"`,
      ),
    ).toBe("pay");
    expect(action(`curl -H "Authorization: Bearer $STRIPE_SECRET_KEY" https://api.stripe.com/v1/balance`)).toBeNull();
  });

  it("asks for a live Alpaca order and not for a paper one", () => {
    expect(action(`curl -X POST https://api.alpaca.markets/v2/orders -d '{}'`)).toBe("pay");
    expect(action(`curl -X POST https://paper-api.alpaca.markets/v2/orders -d '{}'`)).toBeNull();
  });

  it("never reads the known helpers as the agent's own code", () => {
    let read = false;
    expandCommand(`node /opt/skills/meta-ads.mjs insights`, {
      readScript: () => {
        read = true;
        return "";
      },
    });
    expect(read).toBe(false);
  });
});
