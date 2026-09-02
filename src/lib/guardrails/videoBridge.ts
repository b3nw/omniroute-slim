import { createHash } from "node:crypto";

import { getSettings as defaultGetSettings } from "@/lib/db/settings";
import { getResolvedModelCapabilities } from "@/lib/modelCapabilities";
import {
  resolveVideoBridgeRuntimeSettings,
  resolveVisionBridgeRuntimeSettings,
  type VideoAnalysisMode,
} from "@/shared/constants/modalityBridgeDefaults";

import { BaseGuardrail, type GuardrailContext, type GuardrailResult } from "./base";
import type { BridgeCacheStore } from "./modalityBridge/bridgeCache";
import {
  describeVideoPart as defaultDescribeVideoPart,
  extractVideoFocusHint,
  extractVideoParts,
  loadVideoPartBytes,
  replaceVideoParts,
  type DescribeVideoDependencies,
  type DescribedVideo,
  type VideoFusionTelemetry,
  type VideoPart,
} from "./videoBridgeHelpers";
import {
  combineModelIdentities,
  processVideoPart,
  type ProcessVideoPartDeps,
  type VideoAnalysisContext,
} from "./videoBridgePipeline";
import { getSharedVideoResultCacheFor } from "./videoBridgeResultCache";
import { type VisionModelConfig } from "./visionBridgeHelpers";
import { getBestVisionModel } from "./visionBridgeRouter";

export type { VideoAnalysisContext } from "./videoBridgePipeline";

type VideoBridgeBody = {
  model?: string;
  messages?: Array<{ role?: string; content?: unknown }>;
  input?: Array<{ role?: string; content?: unknown }>;
  [key: string]: unknown;
};

export interface VideoBridgeDependencies {
  getSettings?: () => Promise<Record<string, unknown>>;
  getCapabilities?: (model: string) => { supportsVideo: boolean | null };
  describePart?: (part: VideoPart, analysis: VideoAnalysisContext) => Promise<DescribedVideo>;
  extractFrames?: DescribeVideoDependencies["extractFrames"];
  fetchRemote?: DescribeVideoDependencies["fetchRemote"];
  resultCache?: BridgeCacheStore;
  selectVisionModel?: (fixedModel?: string) => Promise<string | null>;
  callVisionModel?: (
    imageDataUri: string,
    config: VisionModelConfig,
    apiKey?: string
  ) => Promise<string>;
}

function resolveVideoAnalysisContext(
  body: VideoBridgeBody,
  requestedAnalysisMode: VideoAnalysisMode
): VideoAnalysisContext {
  const focusHint = requestedAnalysisMode === "focused" ? extractVideoFocusHint(body) : undefined;
  return {
    analysisMode: focusHint ? "focused" : "full",
    ...(focusHint ? { focusHint } : {}),
    focusHintFingerprint: focusHint ? createHash("sha256").update(focusHint).digest("hex") : null,
    requestedAnalysisMode,
  };
}

export class VideoBridgeGuardrail extends BaseGuardrail {
  name = "video-bridge";
  priority = 7;

  private readonly deps: VideoBridgeDependencies;

  constructor(options?: { enabled?: boolean; deps?: VideoBridgeDependencies }) {
    super("video-bridge", { priority: 7, enabled: options?.enabled });
    this.deps = options?.deps ?? {};
  }

  async preCall(payload: unknown, context: GuardrailContext): Promise<GuardrailResult<unknown>> {
    if (!this.enabled || context.disabledGuardrails?.includes("video-bridge")) {
      return { block: false };
    }

    if (context.signal?.aborted) throw new Error("Video Bridge processing was aborted");

    const body = payload as VideoBridgeBody;
    const model = context.model || body.model;
    if (!model) return { block: false };

    const getSettings = this.deps.getSettings ?? defaultGetSettings;
    let persisted: Record<string, unknown> = {};
    try {
      persisted = await getSettings();
    } catch {
      // Early boot can run before the settings database is ready; defaults are safe.
    }
    const runtime = resolveVideoBridgeRuntimeSettings(persisted);
    if (!runtime.enabled) return { block: false };

    const parts = extractVideoParts(body);
    if (parts.length === 0) return { block: false };

    const capabilities = (this.deps.getCapabilities ?? getResolvedModelCapabilities)(model);
    if (capabilities.supportsVideo === true) return { block: false };

    const analysis = resolveVideoAnalysisContext(body, runtime.analysisMode);
    const visionRuntime = resolveVisionBridgeRuntimeSettings(persisted);
    const configuredModel = runtime.model.trim() || visionRuntime.model.trim();
    const routingPlanModel = configuredModel || "auto";
    const cache = runtime.cacheEnabled
      ? (this.deps.resultCache ?? getSharedVideoResultCacheFor(runtime))
      : null;
    const successfulModels = new Set<string>();
    let selectedModelPromise: Promise<string | null> | null = null;
    const selectVideoModel = (): Promise<string | null> => {
      if (!selectedModelPromise) {
        const select =
          this.deps.selectVisionModel ??
          ((fixedModel?: string) => getBestVisionModel({ fixedModel }));
        selectedModelPromise = select(configuredModel || undefined);
      }
      return selectedModelPromise;
    };
    const pipelineDeps: ProcessVideoPartDeps = {
      broker: {
        loadVideoPartBytes,
        extractFrames: this.deps.extractFrames,
        fetchRemote: this.deps.fetchRemote,
      },
      transcription: { describePart: defaultDescribeVideoPart },
      cache,
      selectVideoModel,
      overrideDescribePart: this.deps.describePart,
      callVisionModel: this.deps.callVisionModel,
    };

    const startedAt = Date.now();
    const descriptions: Array<string | null> = [];
    let totalFramesRequested = 0;
    let totalFramesExtracted = 0;
    let totalFramesUsed = 0;
    let totalDurationSeconds = 0;
    let totalCacheHits = 0;
    let totalSamplingCandidateCount = 0;
    let totalDedupDropped = 0;
    let focusWindowsApplied = 0;
    let focusHintsApplied = 0;
    let transcriptCuesApplied = 0;
    let contactSheetsUsed = 0;
    let audioFusionRuns = 0;
    let audioFusionPartials = 0;
    const audioFusionFailureCodes = new Set<string>();
    const recordFusionTelemetry = (fusion?: VideoFusionTelemetry): void => {
      if (!fusion) return;
      audioFusionRuns += 1;
      if (fusion.partial) audioFusionPartials += 1;
      for (const [source, code] of Object.entries(fusion.failures ?? {})) {
        audioFusionFailureCodes.add(`${source}:${code}`);
      }
    };
    let samplingPolicyEffective: "uniform" | "scene_aware" | "segment_aware" = "uniform";
    let failures = 0;

    const attemptedParts = parts.slice(0, runtime.maxVideos);
    for (let index = 0; index < attemptedParts.length; index++) {
      const part = attemptedParts[index];
      const result = await processVideoPart({
        analysis,
        context,
        deps: pipelineDeps,
        part,
        partIndex: index,
        runtime,
        visionRuntime,
      });

      if (result.status === "aborted") {
        throw new Error("Video Bridge processing was aborted");
      }
      if (result.status === "failed") {
        failures += 1;
        descriptions.push(
          capabilities.supportsVideo === false
            ? `[Video ${index + 1}]: (unavailable — video could not be described)`
            : null
        );
        continue;
      }

      descriptions.push(result.description);
      totalFramesRequested += result.framesRequested;
      totalFramesExtracted += result.framesExtracted;
      totalFramesUsed += result.framesUsed;
      totalDedupDropped += result.dedupDropped;
      if (result.hasFocusWindow) focusWindowsApplied += 1;
      if (analysis.analysisMode === "focused") focusHintsApplied += 1;
      totalDurationSeconds += result.durationSeconds;
      totalSamplingCandidateCount += result.samplingCandidateCount;
      transcriptCuesApplied += result.transcriptCuesApplied;
      if (result.contactSheetUsed) contactSheetsUsed += 1;
      recordFusionTelemetry(result.fusion);
      if (result.samplingPolicyEffective !== "uniform") {
        samplingPolicyEffective = result.samplingPolicyEffective;
      }
      for (const producerModel of result.producerModels) successfulModels.add(producerModel);
      totalCacheHits += result.frameCacheHits;
    }

    for (let index = attemptedParts.length; index < parts.length; index++) {
      descriptions.push(
        capabilities.supportsVideo === false
          ? `[Video ${index + 1}]: (not processed because the per-request video limit was reached)`
          : null
      );
    }

    const videosProcessed = attemptedParts.length - failures;
    const videosReplaced = descriptions.filter((description) => description !== null).length;
    if (videosReplaced === 0) return { block: false };

    return {
      block: false,
      modifiedPayload: replaceVideoParts(body, parts, descriptions),
      meta: {
        analysisMode: analysis.analysisMode,
        analysisModeRequested: analysis.requestedAnalysisMode,
        cacheHits: totalCacheHits,
        durationSeconds: totalDurationSeconds,
        failures,
        framesExtracted: totalFramesExtracted,
        framesRequested: totalFramesRequested,
        framesUsed: totalFramesUsed,
        dedupDropped: totalDedupDropped,
        focusWindowsApplied,
        focusHintsApplied,
        transcriptCuesApplied,
        contactSheetsUsed,
        audioFusionRuns,
        audioFusionPartials,
        audioFusionFailureCodes: [...audioFusionFailureCodes].sort(),
        samplingCandidateCount: totalSamplingCandidateCount,
        samplingPolicyEffective,
        samplingPolicyRequested: runtime.samplingPolicy,
        processingTimeMs: Date.now() - startedAt,
        attempts: attemptedParts.length,
        videoModel: combineModelIdentities(successfulModels, routingPlanModel),
        videosProcessed,
        videosReplaced,
      },
    };
  }
}
