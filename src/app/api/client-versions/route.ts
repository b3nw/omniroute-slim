import { NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { validatedJsonBody } from "@/shared/validation/helpers";
import { updateClientVersionModeSchema } from "@/lib/client-versions/schemas";
import {
  ClientVersionValidationError,
  getClientVersionStatus,
  runClientVersionCheck,
  updateClientVersionMode,
} from "@/lib/client-versions/service";

export async function GET(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  try {
    return NextResponse.json(await getClientVersionStatus());
  } catch (error) {
    console.error("Error reading client version modes:", error);
    return NextResponse.json({ error: "Failed to read client version modes" }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;
  const parsed = await validatedJsonBody(request, updateClientVersionModeSchema);
  if (!parsed.success) {
    return "response" in parsed
      ? parsed.response
      : NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  try {
    const modes = await updateClientVersionMode(parsed.data);
    // Switching to automatic without a detected version queries upstream right away;
    // the check never throws and falls back to manual → env → compiled pin on failure.
    const config = modes[parsed.data.product];
    const needsCheck =
      !config.autoDetectedVersion ||
      (parsed.data.product === "antigravity" && !config.autoDetectedCliVersion);
    if (parsed.data.mode === "automatic" && needsCheck) {
      await runClientVersionCheck({ product: parsed.data.product });
    }
    return NextResponse.json(await getClientVersionStatus());
  } catch (error) {
    if (error instanceof ClientVersionValidationError) {
      return NextResponse.json({ error: { message: error.message } }, { status: 400 });
    }
    console.error("Error updating client version mode:", error);
    return NextResponse.json({ error: "Failed to update client version mode" }, { status: 500 });
  }
}
