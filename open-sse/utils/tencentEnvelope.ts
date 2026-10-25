import { isProviderSafetyStopsEnabled } from "./providerSafety.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNestedTencentError(record: Record<string, unknown> | null) {
  const response = asRecord(record?.Response);
  const error = asRecord(response?.Error);
  return error
    ? { message: typeof error.Message === "string" ? error.Message : null, errorCode: error.Code }
    : { message: null, errorCode: undefined };
}

export function unwrapTencentEnvelope(json: unknown): { message: string | null; errorCode: unknown } {
  const record = asRecord(json);
  if (!record) return { message: null, errorCode: undefined };
  if (typeof record.msg === "string") return { message: record.msg, errorCode: record.code };
  const nested = readNestedTencentError(record);
  if (nested.message !== null || nested.errorCode !== undefined) return nested;
  const data = readNestedTencentError(asRecord(record.data));
  return data.message !== null || data.errorCode !== undefined
    ? data
    : { message: null, errorCode: undefined };
}

export function extractJsonErrorFields(
  json: unknown,
  envelopeMessage?: string | null
): { message: unknown; errorCode: unknown; errorType: unknown } {
  const record = asRecord(json) ?? {};
  const tencent = unwrapTencentEnvelope(record);
  const rootError = asRecord(record.error);
  const error = (rootError && Object.keys(rootError).length > 0) || !isProviderSafetyStopsEnabled()
    ? rootError
    : asRecord(asRecord(record.response)?.error);
  return {
    message:
      envelopeMessage || error?.message || record.message ||
      (typeof record.detail === "string" ? record.detail : null) || tencent.message ||
      (typeof record.error === "string" ? record.error : null),
    errorCode: error?.code || record.code || tencent.errorCode,
    errorType: error?.type || record.type,
  };
}
