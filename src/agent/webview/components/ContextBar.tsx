const DEFAULT_OUTPUT_RESERVATION = 128_000;

interface ContextBarProps {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  maxContextWindow: number;
  outputReservation?: number;
  safetyBufferTokens?: number;
  softThresholdBudget?: number;
  hardBudget?: number;
  condenseThreshold?: number;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function ContextBar({
  inputTokens,
  outputTokens,
  cacheReadTokens = 0,
  maxContextWindow,
  outputReservation = DEFAULT_OUTPUT_RESERVATION,
  safetyBufferTokens = 0,
  softThresholdBudget,
  hardBudget,
  condenseThreshold,
}: ContextBarProps) {
  const used = inputTokens + outputTokens;
  const reserved = Math.min(
    outputReservation,
    Math.max(0, maxContextWindow - used),
  );
  const available = Math.max(0, maxContextWindow - used - reserved);

  const usedPct = maxContextWindow > 0 ? (used / maxContextWindow) * 100 : 0;
  const reservedPct =
    maxContextWindow > 0 ? (reserved / maxContextWindow) * 100 : 0;
  const thresholdPct =
    softThresholdBudget != null
      ? (softThresholdBudget / maxContextWindow) * 100
      : condenseThreshold != null
        ? condenseThreshold * 100
        : null;
  const hardBudgetPct =
    hardBudget != null && maxContextWindow > 0
      ? (hardBudget / maxContextWindow) * 100
      : null;

  const tooltipParts = [
    `Used: ${used.toLocaleString()} (input ${inputTokens.toLocaleString()} + output ${outputTokens.toLocaleString()})`,
    `Reserved for response: ${reserved.toLocaleString()}`,
    ...(safetyBufferTokens > 0
      ? [`Safety buffer: ${safetyBufferTokens.toLocaleString()}`]
      : []),
    `Available before response reserve: ${Math.max(0, maxContextWindow - used).toLocaleString()}`,
    `Available after reserve: ${available.toLocaleString()}`,
    ...(cacheReadTokens > 0
      ? [`Cached (0.1x): ${cacheReadTokens.toLocaleString()} tokens`]
      : []),
    ...(thresholdPct != null
      ? [`Auto-condense target: ${Math.round(thresholdPct)}%`]
      : []),
    ...(hardBudgetPct != null
      ? [`Hard fit limit: ${Math.round(hardBudgetPct)}%`]
      : []),
  ];

  return (
    <div class="context-bar" title={tooltipParts.join("\n")}>
      <div class="context-bar-track">
        <div class="context-bar-used" style={{ width: `${usedPct}%` }} />
        <div
          class="context-bar-reserved"
          style={{ width: `${reservedPct}%` }}
        />
        {thresholdPct != null && (
          <div
            class="context-bar-threshold"
            style={{ left: `${thresholdPct}%` }}
            title={
              hardBudgetPct != null
                ? `Auto-condense target: ${Math.round(thresholdPct)}% · Hard fit limit: ${Math.round(hardBudgetPct)}%`
                : `Auto-condense target: ${Math.round(thresholdPct)}%`
            }
          />
        )}
      </div>
      <span class="context-bar-label">
        {formatTokens(used)} / {formatTokens(maxContextWindow)} (
        {Math.round(usedPct)}%)
      </span>
    </div>
  );
}
