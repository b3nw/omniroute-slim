import { describe, it } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";

const modalPath =
  "src/app/(dashboard)/dashboard/providers/[id]/components/modals/EditConnectionModal.tsx";
const source = readFileSync(modalPath, "utf8");

describe("agy Project ID UI support", () => {
  it("declares a single Antigravity-family provider gate", () => {
    assert.ok(
      source.includes(
        'const isAntigravityFamily = provider === "antigravity" || provider === "agy";'
      ),
      "isAntigravityFamily must include antigravity and agy without a separate Google Project ID gate"
    );
  });

  it("does not keep the old supportsGoogleProjectId alias", () => {
    assert.equal(source.includes("supportsGoogleProjectId"), false);
  });

  it("uses antigravityProjectIdLabel for Antigravity-family providers", () => {
    assert.ok(
      source.includes('label={t("antigravityProjectIdLabel")}'),
      "projectId label must use Antigravity-family copy"
    );
  });

  it("gates the Cloud Code project panel on supportsCloudCodeProjectId (incl. gemini-cli)", () => {
    assert.ok(
      source.includes(
        "const supportsCloudCodeProjectId = CLOUD_CODE_PROJECT_ID_PROVIDERS.has(provider);"
      ) && source.includes("{supportsCloudCodeProjectId && (\n          <div"),
      "project id panel must render for every Cloud Code project-id provider"
    );
  });

  it("uses isAntigravityFamily for antigravityClientProfile UI", () => {
    assert.ok(
      source.includes("{isAntigravityFamily && (\n              <Select") &&
        source.includes('label={t("antigravityClientProfileLabel")}'),
      "client profile Select must render only for isAntigravityFamily"
    );
  });

  it("uses isAntigravityFamily for client profile save", () => {
    assert.ok(
      source.includes("...(isAntigravityFamily\n            ? {\n                clientProfile:"),
      "client profile save must use isAntigravityFamily"
    );
  });
});
