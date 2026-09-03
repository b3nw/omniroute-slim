import { NextResponse } from "next/server";
import { cookies } from "next/headers";

export const logoutRouteInternals = {
  getCookieStore: cookies,
};

export async function POST(_request) {
  const cookieStore = await logoutRouteInternals.getCookieStore();
  cookieStore.delete("auth_token");
  return NextResponse.json({ success: true });
}
