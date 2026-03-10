import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from "preact/hooks";
import type { RefObject } from "preact";
import type { ApprovalRequest, RuleEntry, DecisionMessage } from "../types.js";
import { RuleRow } from "./RuleRow.js";
import { ApprovalLayout } from "./ApprovalLayout.js";

interface CommandCardProps {
  request: ApprovalRequest;
  submit: (data: Omit<DecisionMessage, "type">) => void;
  followUpRef: RefObject<string>;
}

export function CommandCard({
  request,
  submit,
  followUpRef,
}: CommandCardProps) {
  const originalCommand = request.command ?? "";
  const [command, setCommand] = useState(originalCommand);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const subCommands = request.subCommands ?? [];
  const [rules, setRules] = useState<RuleEntry[]>(() =>
    subCommands.map((entry) => {
      if (entry.existingRule) {
        return {
          pattern: entry.existingRule.pattern,
          mode: entry.existingRule.mode,
          scope: entry.existingRule.scope,
        };
      }
      return {
        pattern: entry.command,
        mode: "prefix" as const,
        scope: "skip" as const,
      };
    }),
  );

  const isEdited = command !== originalCommand;

  // Snapshot of initial rules for dirty detection — only show "Save Rules"
  // when the user actually modifies something (not just because existing rules match)
  const initialRules = useMemo(
    () =>
      subCommands.map((entry) => {
        if (entry.existingRule) {
          return {
            pattern: entry.existingRule.pattern,
            mode: entry.existingRule.mode,
            scope: entry.existingRule.scope,
          };
        }
        return {
          pattern: entry.command,
          mode: "prefix" as const,
          scope: "skip" as const,
        };
      }),
    [],
  );

  const rulesModified = rules.some((rule, i) => {
    const initial = initialRules[i];
    if (!initial) return true;
    return (
      rule.pattern !== initial.pattern ||
      rule.mode !== initial.mode ||
      rule.scope !== initial.scope
    );
  });

  // Auto-size on command change
  useEffect(() => {
    const el = textareaRef.current;
    if (el && el.clientWidth > 0) {
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, [command]);

  // Re-run sizing when the panel becomes visible (clientWidth goes from 0 to real value)
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w !== lastWidth && w > 0) {
        lastWidth = w;
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleRun = useCallback(() => {
    submit({
      id: request.id,
      decision: isEdited ? "edit" : "run-once",
      ...(isEdited && { editedCommand: command }),
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, isEdited, command, submit, followUpRef]);

  const handleSaveAndRun = useCallback(() => {
    const activeRules = rules.filter((r) => r.scope !== "skip");
    submit({
      id: request.id,
      decision: "run-once",
      rules: activeRules.length > 0 ? rules : undefined,
      ...(isEdited && { editedCommand: command }),
      followUp: followUpRef.current?.trim() || undefined,
    });
  }, [request.id, rules, isEdited, command, submit, followUpRef]);

  const handleReject = useCallback(
    (reason?: string) => {
      submit({ id: request.id, decision: "reject", rejectionReason: reason });
    },
    [request.id, submit],
  );

  const updateRule = useCallback((index: number, value: RuleEntry) => {
    setRules((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }, []);

  const rulesJsx =
    subCommands.length > 0 ? (
      <>
        {subCommands.map((entry, i) => (
          <RuleRow
            key={i}
            entry={entry}
            value={rules[i]}
            onChange={(v) => updateRule(i, v)}
          />
        ))}
      </>
    ) : undefined;

  return (
    <ApprovalLayout
      queuePosition={request.queuePosition}
      queueTotal={request.queueTotal}
      rulesContent={rulesJsx}
      rulesModified={rulesModified}
      primaryLabel="Run"
      primaryWithRulesLabel="Save Rules & Run"
      onAccept={handleRun}
      onSaveAndAccept={handleSaveAndRun}
      onReject={handleReject}
      followUpRef={followUpRef}
    >
      <div class="terminal-box">
        <div class="terminal-header">
          <span class="codicon codicon-terminal" />
          <span>Command</span>
          {isEdited && (
            <span class="edited-badge">
              <span class="codicon codicon-edit" /> modified
            </span>
          )}
        </div>
        <div class="terminal-body">
          <span class="terminal-prompt">$</span>
          <textarea
            ref={textareaRef}
            class={`terminal-input ${isEdited ? "edited" : ""}`}
            value={command}
            onInput={(e) => setCommand((e.target as HTMLTextAreaElement).value)}
            rows={1}
            spellcheck={false}
          />
        </div>
      </div>
    </ApprovalLayout>
  );
}
