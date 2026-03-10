import { useState, useRef, useEffect } from "preact/hooks";
import type { WebviewModelInfo } from "../types";

interface ModelSelectorProps {
  currentModel: string;
  models: WebviewModelInfo[];
  disabled?: boolean;
  onSelect: (modelId: string) => void;
  onSignIn?: (provider: string) => void;
}

export function ModelSelector({
  currentModel,
  models,
  disabled,
  onSelect,
  onSignIn,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = models.find((m) => m.id === currentModel);
  const displayName = current?.displayName ?? currentModel;

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const handleSelect = (modelId: string) => {
    setOpen(false);
    if (modelId !== currentModel) onSelect(modelId);
  };

  // Group models by provider
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
        class="toolbar-control"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        title={`Model: ${displayName}`}
        type="button"
      >
        <i class="codicon codicon-symbol-namespace" />
        <span>{displayName}</span>
        <i
          class={`codicon codicon-chevron-${open ? "up" : "down"} toolbar-selector-chevron`}
        />
      </button>
      {open && (
        <div class="toolbar-selector-dropdown">
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
                {providerModels.map((m) => (
                  <button
                    key={m.id}
                    class={`toolbar-selector-option ${m.id === currentModel ? "active" : ""} ${!m.authenticated ? "disabled" : ""}`}
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
                    {m.id === currentModel && (
                      <i class="codicon codicon-check toolbar-selector-check" />
                    )}
                    {!m.authenticated && (
                      <span class="toolbar-selector-sign-in">Sign in</span>
                    )}
                  </button>
                ))}
              </div>
            ),
          )}
        </div>
      )}
    </div>
  );
}
