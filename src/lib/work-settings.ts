import catalog from "../../agents/dispatcher/work-models.json";

export type WorkSettings = { model: string; effort: string };
type PlatformSettings = { default_model: string; default_effort: string; models: { id: string; name: string; default_effort: string; efforts: string[] }[] };
export const WORK_MODELS: Record<string, PlatformSettings> = catalog.platforms;
export const EFFORT_NAMES: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum", ultra: "Ultra" };
export const EFFORT_HELP: Record<string, string> = {
  low: "Lighter reasoning for quick tasks.", medium: "Balances response time and reasoning depth.",
  high: "More reasoning for complex work.", xhigh: "Extra reasoning for difficult problems; replies may take longer.",
  max: "Maximum reasoning; can take longer and use more of your allowance.",
  ultra: "Maximum reasoning with automatic task delegation; can use more time and allowance.",
};
export class WorkSettingsError extends Error {
  constructor(readonly userMessage: string) { super(userMessage); }
}

export function defaultWorkSettings(platform: string): WorkSettings {
  const provider = WORK_MODELS[platform];
  if (!provider) throw new WorkSettingsError("Choose a supported agent.");
  return { model: provider.default_model, effort: provider.default_effort };
}

/** Only named, compatible settings cross the API/CLI boundary. Never accept raw CLI arguments. */
export function resolveWorkSettings(platform: string, value: { model?: unknown; effort?: unknown } = {}, inherited?: WorkSettings): WorkSettings {
  const provider = WORK_MODELS[platform];
  if (!provider) throw new WorkSettingsError("Choose a supported agent.");
  const modelId = value.model === undefined ? inherited?.model ?? provider.default_model : value.model;
  const model = provider.models.find(m => m.id === modelId);
  if (!model) throw new WorkSettingsError("Choose a model available for this agent.");
  const effort = value.effort === undefined
    ? (inherited?.model === model.id ? inherited.effort : value.model === undefined ? provider.default_effort : model.default_effort)
    : value.effort;
  if (typeof effort !== "string" || !model.efforts.includes(effort)) throw new WorkSettingsError("Choose a supported reasoning effort for this model.");
  return { model: model.id, effort };
}

export function workSettingsLabel(platform: string, settings?: WorkSettings): string {
  if (!settings) return "Previous runner defaults";
  const model = WORK_MODELS[platform]?.models.find(m => m.id === settings.model);
  return `${model?.name ?? settings.model} · ${EFFORT_NAMES[settings.effort] ?? settings.effort} effort`;
}
