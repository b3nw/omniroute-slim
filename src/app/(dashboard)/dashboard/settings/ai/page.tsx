"use client";

import { useTranslations } from "next-intl";
import ThinkingBudgetTab from "../components/ThinkingBudgetTab";
import SystemPromptTab from "../components/SystemPromptTab";
import ResponsesStatePolicyTab from "../components/ResponsesStatePolicyTab";
import CodexFastTierTab from "../components/CodexFastTierTab";
import CodexAutoPingTab from "../components/CodexAutoPingTab";
import ClaudeFastModeTab from "../components/ClaudeFastModeTab";
import ModelsDevSyncTab from "../components/ModelsDevSyncTab";
import UsageTokenBufferTab from "../components/UsageTokenBufferTab";
import ModelCapabilityOverridesTab from "../components/ModelCapabilityOverridesTab";

export default function SettingsAiPage() {
  const t = useTranslations("settings");
  return (
    <div className="space-y-6">
      <p className="text-sm text-text-muted">{t("aiSettingsIntro")}</p>
      <ThinkingBudgetTab />
      <SystemPromptTab />
      <ResponsesStatePolicyTab />
      <UsageTokenBufferTab />
      <CodexFastTierTab />
      <CodexAutoPingTab />
      <ClaudeFastModeTab />
      <ModelCapabilityOverridesTab />
      <ModelsDevSyncTab />
    </div>
  );
}
