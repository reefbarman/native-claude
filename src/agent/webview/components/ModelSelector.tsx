import { useState, useRef, useEffect } from "preact/hooks";
import type { WebviewModelInfo } from "../types";

interface ModelSelectorProps {
  currentModel: string;
  currentCondenseThreshold?: number;
  models: WebviewModelInfo[];
  disabled?: boolean;
  onSelect: (modelId: string) => void;
  onSetCondenseThreshold?: (threshold: number) => void;
  onSignIn?: (provider: string) => void;
}

function thresholdLabel(threshold?: number): string {
  return `${Math.round((threshold ?? 0.9) * 100)}%`;
}

function getModelThreshold(
  model: WebviewModelInfo,
  currentModel: string,
  currentCondenseThreshold?: number,
): number | undefined {
  if (model.id === currentModel) return currentCondenseThreshold;
  return model.condenseThreshold;
}

export function ModelSelector({
  currentModel,
  currentCondenseThreshold,
  models,
  disabled,
  onSelect,
  onSetCondenseThreshold,
  onSignIn,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [sliderOpen, setSliderOpen] = useState(false);
  const [draftThreshold, setDraftThreshold] = useState<number | undefined>(
    currentCondenseThreshold,
  );
  const ref = useRef<HTMLDivElement>(null);

  const current = models.find((m) => m.id === currentModel);
  const displayName = current?.displayName ?? currentModel;
  const effectiveCurrentThreshold =
    sliderOpen && draftThreshold != null
      ? draftThreshold
      : currentCondenseThreshold;
  const thresholdText = thresholdLabel(effectiveCurrentThreshold);

  const commitThreshold = () => {
    if (
      !onSetCondenseThreshold ||
      draftThreshold == null ||
      currentCondenseThreshold == null ||
      draftThreshold === currentCondenseThreshold
    ) {
      return;
    }
    onSetCondenseThreshold(draftThreshold);
  };

  useEffect(() => {
    setDraftThreshold(currentCondenseThreshold);
  }, [currentModel, currentCondenseThreshold]);

  useEffect(() => {
    if (!open) {
      if (sliderOpen) commitThreshold();
      setSliderOpen(false);
      return;
    }
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, sliderOpen, draftThreshold, currentCondenseThreshold]);

  const handleSelect = (modelId: string) => {
    setOpen(false);
    if (modelId !== currentModel) onSelect(modelId);
  };

  const providers = new Map<string, WebviewModelInfo[]>();
  for (const m of models) {
    const list = providers.get(m.provider) ?? [];
    list.push(m);
    providers.set(m.provider, list);
  }

  const providerIcon = (provider: string): string => {
    switch (provider.toLowerCase()) {
      case "anthropic":
        return "symbol-namespace";
      case "codex":
      case "openai":
        return "symbol-interface";
      default:
        return "symbol-namespace";
    }
  };

  return (
    <div class="toolbar-selector" ref={ref}>
      <button
        class="toolbar-control model-selector-trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        title={`Model: ${displayName} · Auto-condense ${thresholdText}`}
        type="button"
      >
        <i class="codicon codicon-symbol-namespace" />
        <span>{displayName}</span>
        <span class="model-selector-threshold-badge">{thresholdText}</span>
        <i
          class={`codicon codicon-chevron-${open ? "up" : "down"} toolbar-selector-chevron`}
        />
      </button>
      {open && (
        <div class="toolbar-selector-dropdown model-selector-dropdown">
          {Array.from(providers.entries()).map(
            ([provider, providerModels], groupIdx) => (
              <div key={provider}>
                {providers.size > 1 && (
                  <>
                    {groupIdx > 0 && <div class="toolbar-selector-divider" />}
                    <div class="toolbar-selector-group-label">
                      <i class={`codicon codicon-${providerIcon(provider)}`} />
                      <span>{provider}</span>
                    </div>
                  </>
                )}
                {providerModels.map((m) => {
                  const isCurrent = m.id === currentModel;
                  const optionThreshold = getModelThreshold(
                    m,
                    currentModel,
                    effectiveCurrentThreshold,
                  );
                  const optionThresholdText = thresholdLabel(optionThreshold);
                  return (
                    <div key={m.id} class="model-selector-option-wrap">
                      <button
                        class={`toolbar-selector-option ${isCurrent ? "active" : ""} ${!m.authenticated ? "disabled" : ""}`}
                        onClick={() => {
                          if (m.authenticated) {
                            handleSelect(m.id);
                          } else if (onSignIn) {
                            setOpen(false);
                            onSignIn(m.provider);
                          }
                        }}
                        type="button"
                      >
                        <span>{m.displayName}</span>
                        <span
                          class={`model-selector-option-threshold ${isCurrent ? "interactive" : ""}`}
                          title={
                            isCurrent
                              ? `Auto-condense ${optionThresholdText} — click to adjust`
                              : `Auto-condense ${optionThresholdText}`
                          }
                          onClick={(e) => {
                            if (!isCurrent) return;
                            e.preventDefault();
                            e.stopPropagation();
                            setSliderOpen((v) => !v);
                          }}
                        >
                          {optionThresholdText}
                          {isCurrent && (
                            <i class="codicon codicon-settings-gear" />
                          )}
                        </span>
                        {isCurrent && (
                          <i class="codicon codicon-check toolbar-selector-check" />
                        )}
                        {!m.authenticated && (
                          <span class="toolbar-selector-sign-in">Sign in</span>
                        )}
                      </button>
                      {isCurrent && sliderOpen && onSetCondenseThreshold && (
                        <div
                          class="model-selector-slider-panel"
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div class="model-selector-slider-header">
                            <span>Auto-condense</span>
                            <span>{optionThresholdText}</span>
                          </div>
                          <input
                            class="model-selector-slider"
                            type="range"
                            min={10}
                            max={100}
                            step={1}
                            value={Math.round(
                              (effectiveCurrentThreshold ?? 0.9) * 100,
                            )}
                            onInput={(e) => {
                              const next = Number(
                                (e.currentTarget as HTMLInputElement).value,
                              );
                              setDraftThreshold(next / 100);
                            }}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
