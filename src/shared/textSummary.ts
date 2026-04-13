export function summarizeTextForPreview(
  text: string | undefined,
  opts?: {
    maxLength?: number;
    minSentenceLength?: number;
  },
): string | undefined {
  if (!text) return undefined;

  const maxLength = opts?.maxLength ?? 220;
  const minSentenceLength = opts?.minSentenceLength ?? 20;

  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;

  const sentence = compact
    .match(
      new RegExp(`(.{${minSentenceLength},${maxLength}}?[.!?])(?:\\s|$)`),
    )?.[1]
    ?.trim();
  const base =
    sentence && sentence.length >= minSentenceLength ? sentence : compact;

  return base.length > maxLength ? `${base.slice(0, maxLength)}…` : base;
}
