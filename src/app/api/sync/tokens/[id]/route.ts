import { NextResponse } from "next/server";
import { createErrorResponse, createErrorResponseFromUnknown } from "@/lib/api/errorResponse";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { getSyncTokenById } from "@/lib/db/syncTokens";
import { revokeSyncTokenById } from "@/lib/sync/tokens";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { id } = await params;
    const existing = await getSyncTokenById(id);
    if (!existing) {
      return createErrorResponse({
        status: 404,
        message: "Sync token not found",
      });
    }

    const revoked = await revokeSyncTokenById(id);
    if (!revoked) {
      return createErrorResponse({
        status: 404,
        message: "Sync token not found",
      });
    }

    return NextResponse.json({
      message: "Sync token revoked successfully",
      syncToken: revoked,
    });
  } catch (error) {
    return createErrorResponseFromUnknown(error, "Failed to revoke sync token");
  }
}
