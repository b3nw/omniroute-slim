import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { makeManagementSessionRequest } from "../helpers/managementSession.ts";

const TEST_DATA_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "omniroute-chatgpt-web-management-retirement-")
);
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = "chatgpt-web-management-retirement-secret";
process.env.INITIAL_PASSWORD = "admin-secret";

const core = await import("../../src/lib/db/core.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const providersRoute = await import("../../src/app/api/providers/route.ts");
const providerByIdRoute = await import("../../src/app/api/providers/[id]/route.ts");
const bulkRoute = await import("../../src/app/api/providers/bulk/route.ts");
const importRoute = await import("../../src/app/api/providers/import/route.ts");
const bulkWebSessionRoute = await import("../../src/app/api/providers/bulk-web-session/route.ts");
const validateRoute = await import("../../src/app/api/providers/validate/route.ts");
const connectionTestRoute = await import("../../src/app/api/providers/[id]/test/route.ts");

const originalFetch = globalThis.fetch;
let networkCalls = 0;

async function resetStorage(): Promise<void> {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  networkCalls = 0;
}

async function managementPost(url: string, body: unknown): Promise<Request> {
  return makeManagementSessionRequest(url, { method: "POST", body });
}

async function assertRetired(response: Response): Promise<void> {
  assert.equal(response.status, 410);
  const body = (await response.json()) as {
    error?: { code?: string; message?: string };
  };
  assert.equal(body.error?.code, "PROVIDER_RETIRED");
  assert.equal(body.error?.message, "Provider is retired and unavailable.");
}

test.before(() => {
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("Retired provider management paths must not reach the network");
  };
});

test.beforeEach(resetStorage);

test.after(() => {
  globalThis.fetch = originalFetch;
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("create, bulk import and validation paths reject retired provider ids with 410", async () => {
  for (const provider of ["chatgpt-web", "cgpt-web"]) {
    await assertRetired(
      await providersRoute.POST(
        await managementPost("http://localhost/api/providers", {
          provider,
          name: `${provider} retired create`,
          apiKey: "retired-secret",
        })
      )
    );

    await assertRetired(
      await bulkRoute.POST(
        await managementPost("http://localhost/api/providers/bulk", {
          provider,
          entries: [{ name: `${provider} retired bulk`, apiKey: "retired-secret" }],
        })
      )
    );

    await assertRetired(
      await importRoute.POST(
        await managementPost("http://localhost/api/providers/import", {
          entries: [{ provider, name: `${provider} retired import`, apiKey: "retired-secret" }],
        })
      )
    );

    await assertRetired(
      await bulkWebSessionRoute.POST(
        await managementPost("http://localhost/api/providers/bulk-web-session", {
          provider,
          entries: [{ name: `${provider} retired web import`, credential: "retired-cookie" }],
        })
      )
    );

    await assertRetired(
      await validateRoute.POST(
        await managementPost("http://localhost/api/providers/validate", {
          provider,
          apiKey: "retired-secret",
        })
      )
    );
  }
  assert.equal(networkCalls, 0);
});

test("retired connections cannot be reactivated, updated or probed", async () => {
  for (const provider of ["chatgpt-web", "cgpt-web"]) {
    const connection = await providersDb.createProviderConnection({
      provider,
      authType: "apikey",
      name: `${provider} retired existing`,
      apiKey: "retired-secret",
      isActive: true,
      testStatus: "active",
    });
    const id = String(connection.id);

    const updateRequest = await makeManagementSessionRequest(
      `http://localhost/api/providers/${id}`,
      { method: "PUT", body: { isActive: true, testStatus: "active" } }
    );
    await assertRetired(
      await providerByIdRoute.PUT(updateRequest, { params: Promise.resolve({ id }) })
    );

    const batchRequest = await makeManagementSessionRequest("http://localhost/api/providers", {
      method: "PATCH",
      body: { ids: [id], isActive: true },
    });
    await assertRetired(await providersRoute.PATCH(batchRequest));

    await assertRetired(
      await connectionTestRoute.POST(
        new Request(`http://localhost/api/providers/${id}/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
        { params: Promise.resolve({ id }) }
      )
    );
  }
  assert.equal(networkCalls, 0);
});
