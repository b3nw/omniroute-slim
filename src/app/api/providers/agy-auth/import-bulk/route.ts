import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import {
  AgyAuthFileError,
  parseAndValidateAgyToken,
  enrichWithAntigravityBackend,
  createConnectionFromAgyToken,
} from "@/lib/oauth/utils/agyAuthImport";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { importAgyAuthBulkSchema } from "@/shared/validation/schemas";
import { validateBody, isValidationFailure } from "@/shared/validation/helpers";
import { sanitizeProviderSpecificDataForResponse } from "@/lib/providers/requestDefaults";

function sanitizeConnectionForResponse(connection: Record<string, unknown>) {
  const safe = { ...connection };
  delete safe.accessToken;
  delete safe.refreshToken;
  delete safe.idToken;
  delete safe.apiKey;
  if (safe.providerSpecificData) {
    safe.providerSpecificData = sanitizeProviderSpecificDataForResponse(safe.providerSpecificData);
  }
  return safe;
}

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsedBody = validateBody(importAgyAuthBulkSchema, body);
  if (isValidationFailure(parsedBody)) {
    return NextResponse.json({ error: parsedBody.error }, { status: 400 });
  }

  const { entries, overwriteExisting } = parsedBody.data;

  const created: Record<string, unknown>[] = [];
  const errors: { index: number; name: string; message: string }[] = [];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const label = e.name || `entry ${i + 1}`;
    try {
      const parsed = parseAndValidateAgyToken(e.json);
      const enriched = await enrichWithAntigravityBackend(parsed);
      const { connection } = await createConnectionFromAgyToken(enriched, {
        name: e.name,
        email: e.email,
        overwriteExisting,
      });

      created.push(sanitizeConnectionForResponse(connection as Record<string, unknown>));

    } catch (err) {
      const message =
        err instanceof AgyAuthFileError
          ? err.message
          : sanitizeErrorMessage(err) || "Failed to import";
      errors.push({ index: i, name: label, message });
    }
  }

  return NextResponse.json({
    success: created.length,
    failed: errors.length,
    total: entries.length,
    created,
    errors,
  });
}
