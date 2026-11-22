import { describe, expect, it } from "vitest";
import { freeSecretName, scanForSecrets } from "./secret-hygiene";

const marker = (secret: { label: string }) => `[hidden ${secret.label}]`;

describe("scanForSecrets", () => {
  it("hides provider keys and names them", () => {
    const token = `ghp_${"a1B2".repeat(9)}`;
    const scan = scanForSecrets(`here is the token ${token} for the repo`, marker);
    expect(scan.text).toBe("here is the token [hidden GitHub token] for the repo");
    expect(scan.found).toEqual([{ label: "GitHub token", name: "GITHUB_TOKEN", value: token }]);
  });

  it("hides a value after a password word in Spanish and English", () => {
    const scan = scanForSecrets("usuario: ana\ncontraseña: Pan-de-oro77\npassword = hunter22!", marker);
    expect(scan.text).toBe("usuario: ana\ncontraseña: [hidden password]\npassword = [hidden password]");
    expect(scan.found.map((secret) => secret.value)).toEqual(["Pan-de-oro77", "hunter22!"]);
    expect(scanForSecrets("mi clave es Ñandú2024.", marker).found.map((secret) => secret.value)).toEqual([
      "Ñandú2024.",
    ]);
  });

  it("leaves plain talk about passwords alone", () => {
    for (const text of [
      "the password is in the vault",
      "password: required",
      "token: https://example.com/a1",
      "my api key is ready",
      "he said the token expired",
      "The password is correct.",
      "my api key is ready.",
      "the token is invalid, try again",
      "La contraseña es válida",
      "la clave es económica.",
    ])
      expect(scanForSecrets(text, marker)).toEqual({ text, found: [] });
  });

  it("names a prefixed key after a label for its provider, once", () => {
    const key = `sk_live_${"9xZ".repeat(10)}`;
    const scan = scanForSecrets(`stripe token: ${key} (again ${key})`, marker);
    expect(scan.text).toBe("stripe token: [hidden Stripe key] (again [hidden Stripe key])");
    expect(scan.found).toHaveLength(1);
    expect(scan.found[0]?.name).toBe("STRIPE_SECRET_KEY");
  });

  it("hides a private key block and a web token", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----";
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const scan = scanForSecrets(`${pem}\n${jwt}`, marker);
    expect(scan.text).toBe("[hidden private key]\n[hidden access token]");
  });
});

describe("freeSecretName", () => {
  it("adds a number when the name is taken", () => {
    expect(freeSecretName("GITHUB_TOKEN", new Set())).toBe("GITHUB_TOKEN");
    expect(freeSecretName("GITHUB_TOKEN", new Set(["GITHUB_TOKEN", "GITHUB_TOKEN_2"]))).toBe("GITHUB_TOKEN_3");
  });
});
