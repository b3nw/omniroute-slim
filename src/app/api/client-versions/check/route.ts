import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { validateBody, isValidationFailure } from "@/shared/validation/helpers";
import { checkClientVersionSchema } from "@/lib/client-versions/schemas";
import { getClientVersionStatus, runClientVersionCheck } from "@/lib/client-versions/service";

export async function POST(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  // Body is optional: an empty body checks every product in automatic mode.
  let rawBody: unknown = {};
  const text = await request.text().catch(() => "");
  if (text.trim()) {
    try {
      rawBody = JSON.parse(text);
    } catch {
      return NextResponse.json(
        {
          error: {
            message: "Invalid request",
            details: [{ field: "body", message: "Invalid JSON body" }],
          },
        },
        { status: 400 }
      );
    }
  }
  const validation = validateBody(checkClientVersionSchema, rawBody);
  if (isValidationFailure(validation)) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  try {
    const result = await runClientVersionCheck({ product: validation.data.product });
    return NextResponse.json({ ...result, ...(await getClientVersionStatus()) });
  } catch (error) {
    console.error("Error running client version check:", error);
    return NextResponse.json({ error: "Failed to run client version check" }, { status: 500 });
  }
}
