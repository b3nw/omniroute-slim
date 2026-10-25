import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractM365CredentialParts } from "../../src/lib/providers/validation/webProvidersB.ts";
import { extractM365CredentialFromHar } from "../../src/shared/utils/m365HarImport.ts";
import { resolveConnectionParams } from "../../open-sse/executors/copilot-m365-connection.ts";
import {
  isTrustedM365ChatHubHost,
  isTrustedM365ChatHubUrl,
} from "../../open-sse/utils/m365Credentials.ts";

const path = "user-oid@tenant-id";
const token = "synthetic.token.value";
const url = (host: string) => `wss://${host}/m365Copilot/Chathub/${path}?access_token=${token}`;
const har = (...urls: string[]) =>
  JSON.stringify({ log: { entries: urls.map((url) => ({ request: { url } })) } });

describe("M365 ChatHub trusted hosts (#16327)", () => {
  for (const host of [
    "m365.cloud.microsoft",
    "eu.m365.cloud.microsoft",
    "copilot.microsoft.com",
    "substrate.office.com",
    "substrate.svc.cloud.microsoft",
    "SUBSTRATE.SVC.CLOUD.MICROSOFT:443",
    "M365.CLOUD.MICROSOFT:443",
  ]) {
    it(`accepts ${host} through HAR import, validation and execution`, () => {
      const imported = extractM365CredentialFromHar(har(url(host)));
      assert.equal(imported.ok, true);
      if (!imported.ok) return;
      assert.equal(imported.chathubPath, path);

      const extracted = extractM365CredentialParts(url(host), {});
      assert.equal(extracted.accessToken, token);
      assert.equal(extracted.chathubPath, path);

      const pasted = resolveConnectionParams({ apiKey: url(host) });
      assert.ok(!("error" in pasted));
      assert.equal(pasted.accessToken, token);
      assert.equal(pasted.chathubPath, path);
    });
  }

  it("matches substrate.svc.cloud.microsoft exactly", () => {
    assert.equal(isTrustedM365ChatHubHost("substrate.svc.cloud.microsoft"), true);
    assert.equal(isTrustedM365ChatHubHost("sub.substrate.svc.cloud.microsoft"), false);
    assert.equal(isTrustedM365ChatHubHost("other.svc.cloud.microsoft"), false);
    assert.equal(isTrustedM365ChatHubHost("substrate.svc.cloud.microsoft.attacker.invalid"), false);
  });

  it("selects the last eligible HAR URL", () => {
    const imported = extractM365CredentialFromHar(
      har(
        url("substrate.office.com").replace(token, "old"),
        url("substrate.svc.cloud.microsoft"),
        url("attacker.invalid").replace(token, "attacker")
      )
    );
    assert.equal(imported.ok, true);
    if (!imported.ok) return;
    assert.match(imported.apiKey, new RegExp(`access_token=${token};`));
  });

  for (const unsafe of [
    url("m365.cloud.microsoft.attacker.invalid"),
    url("attacker.invalid"),
    url("substrate.svc.cloud.microsoft.attacker.invalid"),
    url("sub.substrate.svc.cloud.microsoft"),
    url("other.svc.cloud.microsoft"),
    url("user@substrate.svc.cloud.microsoft"),
    url("substrate.svc.cloud.microsoft:8443"),
    url("substrate.svc.cloud.microsoft").replace("wss:", "ws:"),
    url("substrate.svc.cloud.microsoft").replace("wss:", "https:"),
    url("substrate.svc.cloud.microsoft").replace("Chathub", "StreamHub"),
    url("m365.cloud.microsoft:8443"),
    url("user@m365.cloud.microsoft"),
    url("m365.cloud.microsoft").replace("wss:", "ws:"),
  ]) {
    it(`rejects untrusted ChatHub URL ${unsafe.replace(token, "REDACTED")}`, () => {
      let parsed: URL | null = null;
      try {
        parsed = new URL(unsafe);
      } catch {
        // Malformed URLs are rejected by construction.
      }
      if (parsed) assert.equal(isTrustedM365ChatHubUrl(parsed), false);

      const imported = extractM365CredentialFromHar(har(unsafe));
      assert.equal(imported.ok, false);

      const extracted = extractM365CredentialParts(unsafe, {});
      assert.notEqual(extracted.accessToken, token);

      const pasted = resolveConnectionParams({ apiKey: unsafe });
      assert.ok("error" in pasted);
      if ("error" in pasted) assert.ok(!pasted.error.includes(token));
    });
  }

  it("reports a malformed ChatHub path on a trusted host as unparsable instead of throwing", () => {
    const imported = extractM365CredentialFromHar(
      har(url("substrate.svc.cloud.microsoft").replace(path, "%ZZ"))
    );
    assert.deepEqual(imported, { ok: false, error: "unparsableUrl" });
  });
});
