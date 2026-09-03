import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { ClaudeAuthFileError } from "@/lib/oauth/utils/claudeAuthFile";
import {
  parseAndValidateClaudeAuth,
  enrichWithBootstrap,
  createConnectionFromAuthFile,
} from "@/lib/oauth/utils/claudeAuthImport";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";
import { importClaudeAuthBulkSchema } from "@/shared/validation/schemas";
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

  const parsedBody = validateBody(importClaudeAuthBulkSchema, body);
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
      const parsedAuth = parseAndValidateClaudeAuth(e.json);
      const enriched = await enrichWithBootstrap(parsedAuth);
      const { connection } = await createConnectionFromAuthFile(enriched, {
        name: e.name,
        email: e.email,
        overwriteExisting,
      });

      const safe = sanitizeConnectionForResponse(connection as Record<string, unknown>);
      created.push(safe);

    } catch (err) {
      let message: string;
      if (err instanceof ClaudeAuthFileError) {
        message = err.message;
      } else {
        message = sanitizeErrorMessage(err) || "Failed to import";
      }
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
