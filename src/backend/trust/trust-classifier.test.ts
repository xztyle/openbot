import type { DynamicRecord } from "@openbot/contracts/runtime-values";
import { localizeSourceText } from "@openbot/i18n/source";
import { describe, expect, it } from "vitest";
import { impactOf, monitorPrompt } from "../guardrails/injection-guard";
import { moneyEffect } from "../guardrails/money-approvals";
import {
  classifyBrowserCall,
  classifyCommand,
  expandCommand,
  isReadOnlyPageScript,
  pushesOnlyReviewBranches,
} from "./trust-classifier";

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

describe("a git push of the landings", () => {
  // The push that the injection monitor blocked on 2026-11-23: a fix on a review branch for QA.
  const reviewPush =
    "cd /data/OpenBot/Spaces/universidad-online/Shared/wt-lucete && GIT_ASKPASS=/data/OpenBot/Spaces/universidad-online/Shared/git-askpass.sh GIT_TERMINAL_PROMPT=0 git push -q origin cambio/lucete-hero 2>&1|tail -1";

  it("is normal work on a review branch, not a publish", () => {
    expect(pushesOnlyReviewBranches(reviewPush)).toBe(true);
    const landings = reviewPush.replace("wt-lucete", "aprendivo-landings");
    // No high-impact action, so the injection monitor is never asked about it.
    expect(impactOf("Bash", { command: landings }, classifyCommand(landings))).toBeNull();
    expect(classifyCommand(reviewPush.replace("wt-lucete", "aprendivo-landings"))).toBeNull();
    expect(classifyCommand("cd aprendivo-landings && git push origin HEAD:cambio/hero")).toBeNull();
  });

  it("publishes when it pushes main, production, the current branch or everything", () => {
    for (const push of [
      "cd aprendivo-landings && git push origin main",
      "cd aprendivo-landings && git push origin cambio/hero:main",
      "cd aprendivo-landings && git push",
      "cd aprendivo-landings && git push origin HEAD",
      "cd aprendivo-landings && git push --all origin",
      "cd aprendivo-landings && git push origin cambio/hero && git push origin main",
    ])
      expect(classifyCommand(push)?.label, push).toBe("git push (landings)");
    // A force push rewrites production: a deletion that only the owner approves.
    const forced = classifyCommand("cd aprendivo-landings && git push -f origin +refs/heads/production");
    expect(forced && { action: forced.action, deletes: forced.deletes }).toEqual({
      action: "delete",
      deletes: "owner",
    });
  });
});

describe("the injection monitor's prompt", () => {
  it("tells the judge that review-branch work is not a deployment", () => {
    const prompt = monitorPrompt(
      [{ from: "owner", text: "Publishing waits for both QAs' OK." }],
      [{ source: "web", excerpt: "QA notes" }],
      { kind: "deploy", label: "git push (landings)", summary: "git push origin main" },
    );
    expect(prompt).toContain("pushing a review branch");
    expect(prompt).toContain("limits only merging or publishing to production");
  });
});

// Failure mode: an agent that only reads the offer of a checkout link asks the owner to approve a
// payment of "? USD" on each read; or a script that clicks Buy passes as a read and pays unasked.
describe("browser calls on a checkout page", () => {
  const checkout = "https://pay.hotmart.com/A1234567B?off=xyz789&checkoutMode=10";
  const browserAction = (tool: string, args: DynamicRecord, url = checkout) =>
    classifyBrowserCall(tool, { tabId: "tab-1", ...args }, url)?.action ?? null;
  const evaluate = (expression: string, url = checkout) => browserAction("evaluate", { expression }, url);

  it("lets a read-only evaluate run with no payment approval", () => {
    expect(evaluate("location.href")).toBeNull();
    expect(evaluate('new URLSearchParams(location.search).get("off")')).toBeNull();
    expect(evaluate('new URL(window.location.href).searchParams.get("off")')).toBeNull();
    expect(evaluate("document.title")).toBeNull();
    expect(evaluate('document.querySelector("h1")?.textContent?.trim()')).toBeNull();
    expect(evaluate('document.querySelector("[data-offer]").getAttribute("data-offer")')).toBeNull();
    expect(evaluate("location.href.match(/off=([^&]+)/)?.[1]")).toBeNull();
    expect(
      evaluate('Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href")).filter(Boolean)'),
    ).toBeNull();
    expect(evaluate("({ url: location.href, title: document.title })")).toBeNull();
  });

  it("treats an evaluate that clicks, submits, sends or writes as a payment", () => {
    expect(evaluate('document.querySelector("button[type=submit]").click()')).toBe("pay");
    expect(evaluate('document.querySelector("form").submit()')).toBe("pay");
    expect(evaluate('document.querySelector("form").requestSubmit()')).toBe("pay");
    expect(evaluate('document.querySelector("button").dispatchEvent(new MouseEvent("click"))')).toBe("pay");
    expect(evaluate('fetch("/api/checkout", { method: "POST" })')).toBe("pay");
    expect(evaluate("new XMLHttpRequest()")).toBe("pay");
    expect(evaluate('location.href = "https://pay.hotmart.com/buy"')).toBe("pay");
    expect(evaluate('location.assign("/buy")')).toBe("pay");
    expect(evaluate('document.querySelector("input").value = "4111"')).toBe("pay");
    expect(evaluate('document.querySelector("a")["cl" + "ick"]()')).toBe("pay");
    expect(evaluate('document.querySelector("a").click\u0028)')).toBe("pay");
    expect(evaluate("document.defaultView.checkout")).toBe("pay");
    expect(evaluate("window.buyNow")).toBe("pay");
    expect(evaluate('[...document.querySelectorAll("button")].forEach((b) => b.click())')).toBe("pay");
    expect(evaluate("(() => { document.forms[0].submit(); })()")).toBe("pay");
    expect(evaluate("let x = 1")).toBe("pay");
    expect(evaluate("location.href // read")).toBe("pay");
    expect(evaluate(`\`\${location.href}\``)).toBe("pay");
    expect(evaluate("x".repeat(5_000))).toBe("pay");
  });

  it("keeps a card fill and every click, key and typed text on checkout a payment", () => {
    expect(
      browserAction("fill_card", { cardId: "card-1", targets: { number: { kind: "ref", ref: "e1", revision: 1 } } }),
    ).toBe("pay");
    expect(browserAction("click", { target: { kind: "role", role: "button", name: "Comprar ahora" } })).toBe("pay");
    expect(browserAction("press", { key: "Enter" })).toBe("pay");
    expect(browserAction("type", { target: { kind: "ref", ref: "e4", revision: 1 }, text: "4111" })).toBe("pay");
    expect(browserAction("run_steps", { steps: [{ action: "click", target: { kind: "ref", ref: "e9" } }] })).toBe(
      "pay",
    );
    expect(
      browserAction("click", { target: { kind: "ref", ref: "e2" } }, "https://checkout.stripe.com/c/pay/cs_1"),
    ).toBe("pay");
  });

  it("leaves reads and pages that are not checkouts alone", () => {
    expect(browserAction("snapshot", {})).toBeNull();
    expect(browserAction("status", {})).toBeNull();
    expect(
      browserAction("click", { target: { kind: "ref", ref: "e2" } }, "https://hotmart.com/es/marketplace"),
    ).toBeNull();
  });

  it("says plainly what the call does on the card, with no question mark for the amount", () => {
    const click = classifyBrowserCall(
      "click",
      { tabId: "tab-1", target: { kind: "role", role: "button", name: "Comprar ahora" } },
      checkout,
    );
    expect(click?.browser).toEqual({ site: "pay.hotmart.com", what: 'click button "Comprar ahora"' });
    if (!click) throw new Error("A click on checkout is a payment.");
    const effect = moneyEffect(click, null);
    expect(effect.headline).toBe(
      'Acts on a payment page (pay.hotmart.com), amount unknown: click button "Comprar ahora"',
    );
    expect(effect.payByHand).toBeNull();
    expect(`${effect.headline}${effect.payByHand ?? ""}`).not.toContain("?");
    const api = moneyEffect({ action: "pay", label: "hotmart pay", summary: "hotmart pay", platform: "hotmart" }, null);
    expect(api.headline).toBe("Hotmart · pay an unknown amount");
    expect(api.payByHand).toBe("After you approve: pay by hand at the hotmart page. The amount is unknown.");
  });

  it("shows the card in the reader's language", () => {
    expect(
      localizeSourceText('Acts on a payment page (pay.hotmart.com), amount unknown: click button "Comprar"', "es"),
    ).toBe('Actúa en una página de pago (pay.hotmart.com), monto desconocido: click button "Comprar"');
    expect(
      localizeSourceText(
        "Ana wants to act on a payment page (pay.hotmart.com): evaluate: x. The trust policy asks you first.",
        "es",
      ),
    ).toBe(
      "Ana quiere actuar en una página de pago (pay.hotmart.com): evaluate: x. La política de confianza te pregunta primero.",
    );
  });

  it("reads simple scripts as read-only and nothing else", () => {
    expect(isReadOnlyPageScript("document.cookie")).toBe(true);
    expect(isReadOnlyPageScript("document.cookie = 'a=1'")).toBe(false);
    expect(isReadOnlyPageScript("i++")).toBe(false);
    expect(isReadOnlyPageScript("eval('1')")).toBe(false);
  });
});
