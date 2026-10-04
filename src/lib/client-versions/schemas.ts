import { z } from "zod";
import {
  CLIENT_VERSION_MODES,
  CLIENT_VERSION_PRODUCTS,
  SAFE_CLIENT_VERSION_PATTERN,
} from "./registry";

// Trim before the pattern check; the pattern itself rejects CR/LF, spaces and
// any other header-injection characters.
const manualVersionSchema = z
  .string()
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: "Version must not contain control characters",
  })
  .transform((value) => value.trim())
  .refine((value) => value === "" || SAFE_CLIENT_VERSION_PATTERN.test(value), {
    message: "Version must match /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/",
  });

export const updateClientVersionModeSchema = z
  .object({
    product: z.enum(CLIENT_VERSION_PRODUCTS),
    mode: z.enum(CLIENT_VERSION_MODES),
    manualVersion: manualVersionSchema.optional(),
    // Antigravity only: its CLI (1.x) is versioned apart from the IDE (2.x).
    manualCliVersion: manualVersionSchema.optional(),
  })
  .strict()
  .refine((body) => body.manualCliVersion === undefined || body.product === "antigravity", {
    message: "manualCliVersion is only supported for antigravity",
    path: ["manualCliVersion"],
  })
  .refine((body) => body.mode !== "manual" || !!body.manualVersion, {
    message: "manualVersion is required for manual mode",
    path: ["manualVersion"],
  });

export const checkClientVersionSchema = z
  .object({
    product: z.enum(CLIENT_VERSION_PRODUCTS).optional(),
  })
  .strict();
