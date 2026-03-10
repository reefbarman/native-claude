import { useRef, useEffect, useMemo, useState } from "preact/hooks";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import mermaid from "mermaid";

let mermaidInitialized = false;
function ensureMermaidInit() {
  if (mermaidInitialized) return;
  mermaidInitialized = true;
  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    securityLevel: "loose",
    fontFamily: "var(--vscode-font-family)",
    themeVariables: {
      // AgentLink brand teal
      primaryColor: "#2a5e58",
      primaryTextColor: "#e0e0e0",
      primaryBorderColor: "#4ECDC4",
      secondaryColor: "#1e3a36",
      secondaryTextColor: "#e0e0e0",
      secondaryBorderColor: "#3ba89f",
      tertiaryColor: "#163330",
      tertiaryTextColor: "#e0e0e0",
      tertiaryBorderColor: "#2d7a72",
      // Lines and text
      lineColor: "#4ECDC4",
      textColor: "#e0e0e0",
      // Background
      mainBkg: "#2a5e58",
      nodeBorder: "#4ECDC4",
      // Notes and labels
      noteBkgColor: "#1e3a36",
      noteTextColor: "#e0e0e0",
      noteBorderColor: "#4ECDC4",
      // Sequence diagram
      actorBkg: "#2a5e58",
      actorBorder: "#4ECDC4",
      actorTextColor: "#e0e0e0",
      actorLineColor: "#4ECDC4",
      signalColor: "#e0e0e0",
      signalTextColor: "#e0e0e0",
      labelBoxBkgColor: "#1e3a36",
      labelBoxBorderColor: "#4ECDC4",
      labelTextColor: "#e0e0e0",
      loopTextColor: "#e0e0e0",
      activationBorderColor: "#4ECDC4",
      activationBkgColor: "#1e3a36",
      sequenceNumberColor: "#1a1a2e",
      // Pie chart
      pie1: "#4ECDC4",
      pie2: "#3ba89f",
      pie3: "#2d7a72",
      pie4: "#1e5c56",
      pie5: "#164e48",
      pie6: "#0e3d38",
      pie7: "#082e2a",
      pieTitleTextColor: "#e0e0e0",
      pieSectionTextColor: "#1a1a2e",
      // Git graph
      git0: "#4ECDC4",
      git1: "#3ba89f",
      git2: "#2d7a72",
      git3: "#1e5c56",
      gitBranchLabel0: "#1a1a2e",
      gitBranchLabel1: "#1a1a2e",
      gitBranchLabel2: "#e0e0e0",
      gitBranchLabel3: "#e0e0e0",
      // ER diagram
      entityBorder: "#4ECDC4",
      entityBkg: "#2a5e58",
      entityTextColor: "#e0e0e0",
      relationColor: "#4ECDC4",
      attributeBackgroundColorEven: "#1e3a36",
      attributeBackgroundColorOdd: "#2a5e58",
    },
  });
}

/**
 * Closed mermaid fences only (must include terminating ```) to avoid
 * rendering partial diagrams while text is still streaming.
 */
const MERMAID_FENCE_RE = /```mermaid[^\r\n]*\r?\n([\s\S]*?)\r?\n```/g;

function renderMermaidContainer(idx: number, source: string): string {
  const escapedCode = source
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<div class="mermaid-container" data-mermaid-idx="${idx}"><div class="mermaid-diagram"><pre><code>${escapedCode}</code></pre></div><div class="mermaid-actions"><button type="button" class="mermaid-toggle-code">Show Code</button><button type="button" class="mermaid-popout">Pop Out</button></div><pre class="mermaid-source" style="display:none"><code>${escapedCode}</code></pre></div>`;
}

function parseMarkdown(text: string): {
  html: string;
  mermaidSources: string[];
} {
  const mermaidSources: string[] = [];

  const localMarked = new Marked({
    renderer: {
      html({ text }: { text: string }) {
        return text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      },
      code({ text, lang }: { text: string; lang?: string }) {
        const langClass = lang ? ` class="language-${lang}"` : "";
        return `<pre><code${langClass}>${text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")}</code></pre>`;
      },
    },
  });

  let raw = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  MERMAID_FENCE_RE.lastIndex = 0;
  while ((match = MERMAID_FENCE_RE.exec(text)) !== null) {
    const [fullMatch, source] = match;
    const start = match.index;
    if (start > lastIndex) {
      raw += localMarked.parse(text.slice(lastIndex, start), {
        async: false,
      }) as string;
    }
    const idx = mermaidSources.length;
    mermaidSources.push(source);
    raw += renderMermaidContainer(idx, source);
    lastIndex = start + fullMatch.length;
  }

  if (lastIndex < text.length) {
    raw += localMarked.parse(text.slice(lastIndex), { async: false }) as string;
  }

  const html = DOMPurify.sanitize(raw, {
    ALLOWED_URI_REGEXP: /^(?:https?|vscode):/i,
    ADD_ATTR: ["data-mermaid-idx"],
  });

  return { html, mermaidSources };
}

// Matches file paths like `src/foo/bar.ts`, `/abs/path.ts`, `src/foo.ts:42`
const FILE_PATH_RE =
  /(?<![:/])\b((?:(?:\/[\w.\-]+)+|[\w][\w\-]*(?:\/[\w.\-]+)+)\.\w{1,8})(?::(\d+)(?:-\d+)?)?/g;

function linkifyFilePathNodes(
  container: HTMLElement,
  onOpenFile: (path: string, line?: number) => void,
) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let el = node.parentElement;
      while (el && el !== container) {
        const tag = el.tagName;
        if (tag === "CODE" || tag === "PRE" || tag === "A") {
          return NodeFilter.FILTER_REJECT;
        }
        el = el.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) textNodes.push(n as Text);

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? "";
    FILE_PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    const parts: Node[] = [];

    while ((match = FILE_PATH_RE.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const filePath = match[1];
      const line = match[2] ? parseInt(match[2], 10) : undefined;
      const a = document.createElement("a");
      a.className = "file-path-link";
      a.textContent = match[0];
      a.href = "#";
      a.title = `Open ${filePath}${line !== undefined ? `:${line}` : ""}`;
      a.addEventListener("click", (e) => {
        e.preventDefault();
        onOpenFile(filePath, line);
      });
      parts.push(a);
      lastIndex = match.index + match[0].length;
    }

    if (parts.length > 0) {
      if (lastIndex < text.length) {
        parts.push(document.createTextNode(text.slice(lastIndex)));
      }
      const parent = textNode.parentNode;
      if (parent) {
        for (const p of parts) parent.insertBefore(p, textNode);
        parent.removeChild(textNode);
      }
    }
  }
}

interface StreamingTextProps {
  text: string;
  streaming: boolean;
  onRevealStart?: () => void;
  onOpenMermaidPanel?: (source: string) => void;
  onOpenFile?: (path: string, line?: number) => void;
}

// Minimum chars to buffer before we start revealing (~1200 chars ≈ a few paragraphs)
const INITIAL_BUFFER = 1200;
// Base chars per frame when we have a large backlog
const MIN_CHARS_PER_FRAME = 1;
// Max chars per frame to catch up when far behind
const MAX_CHARS_PER_FRAME = 6;
// How aggressively to catch up (higher = faster catchup)
const CATCHUP_FACTOR = 0.04;

export function StreamingText({
  text,
  streaming,
  onRevealStart,
  onOpenMermaidPanel,
  onOpenFile,
}: StreamingTextProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [revealedLen, setRevealedLen] = useState(streaming ? 0 : text.length);
  const rafRef = useRef<number>(0);
  const targetLenRef = useRef(text.length);
  const bufferingRef = useRef(streaming);
  const revealStartedRef = useRef(!streaming);

  // When not streaming, show everything immediately
  useEffect(() => {
    if (!streaming) {
      setRevealedLen(text.length);
      bufferingRef.current = false;
      cancelAnimationFrame(rafRef.current);
      if (!revealStartedRef.current) {
        revealStartedRef.current = true;
        onRevealStart?.();
      }
    }
  }, [streaming, text.length, onRevealStart]);

  // Update target length when text grows, end buffering once we have enough
  useEffect(() => {
    targetLenRef.current = text.length;
    if (bufferingRef.current && text.length >= INITIAL_BUFFER) {
      bufferingRef.current = false;
      if (!revealStartedRef.current) {
        revealStartedRef.current = true;
        onRevealStart?.();
      }
    }
  }, [text.length, onRevealStart]);

  // Animate reveal during streaming
  useEffect(() => {
    if (!streaming) return;

    const tick = () => {
      setRevealedLen((prev) => {
        if (bufferingRef.current) return prev;
        const target = targetLenRef.current;
        if (prev >= target) return prev;
        // Adaptive speed: reveal faster when further behind
        const gap = target - prev;
        const speed = Math.max(
          MIN_CHARS_PER_FRAME,
          Math.min(MAX_CHARS_PER_FRAME, Math.ceil(gap * CATCHUP_FACTOR)),
        );
        return Math.min(prev + speed, target);
      });
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [streaming]);

  // Parse the FULL text to get stable mermaid sources (not affected by reveal animation)
  const fullParsed = useMemo(() => parseMarkdown(text), [text]);
  const mermaidSourcesRef = useRef<string[]>([]);
  mermaidSourcesRef.current = fullParsed.mermaidSources;

  // Parse the revealed portion for display (mermaid sources from this are ignored)
  const displayText = streaming ? text.slice(0, revealedLen) : text;
  const parsed = useMemo(() => parseMarkdown(displayText), [displayText]);

  // Track which mermaid indices have been rendered (survives across re-renders)
  const renderedMermaidRef = useRef<Set<number>>(new Set());
  // Track in-flight renders to avoid duplicates
  const renderingMermaidRef = useRef<Set<number>>(new Set());

  // Reset when the underlying text changes (new message)
  useEffect(() => {
    renderedMermaidRef.current.clear();
    renderingMermaidRef.current.clear();
  }, [text]);

  // Update DOM
  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = parsed.html;

    // Linkify bare file paths in text nodes (skips code/pre blocks)
    if (onOpenFile) {
      linkifyFilePathNodes(containerRef.current, onOpenFile);
    }

    // Re-stamp already-rendered diagrams — their SVGs were lost when innerHTML was reset
    // We cache rendered SVGs so we can restore them instantly
    containerRef.current
      .querySelectorAll(".mermaid-container[data-mermaid-idx]")
      .forEach((el) => {
        const idx = parseInt(el.getAttribute("data-mermaid-idx") ?? "", 10);
        const cached = mermaidSvgCache.current.get(idx);
        if (cached !== undefined) {
          const diagramEl = el.querySelector(".mermaid-diagram") as HTMLElement;
          if (diagramEl) diagramEl.innerHTML = cached;
        }
      });

    // Wire up toggle buttons
    containerRef.current
      .querySelectorAll(".mermaid-toggle-code")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const container = btn.closest(".mermaid-container");
          if (!container) return;
          const sourceEl = container.querySelector(
            ".mermaid-source",
          ) as HTMLElement;
          if (!sourceEl) return;
          const hidden = sourceEl.style.display === "none";
          sourceEl.style.display = hidden ? "block" : "none";
          btn.textContent = hidden ? "Hide Code" : "Show Code";
        });
      });

    containerRef.current.querySelectorAll(".mermaid-popout").forEach((btn) => {
      btn.addEventListener("click", () => {
        const container = btn.closest(".mermaid-container");
        if (!container) return;
        const idx = parseInt(
          container.getAttribute("data-mermaid-idx") ?? "",
          10,
        );
        const source = Number.isFinite(idx)
          ? mermaidSourcesRef.current[idx]
          : "";
        if (!source) return;
        onOpenMermaidPanel?.(source);
      });
    });
  }, [parsed.html, onOpenMermaidPanel, onOpenFile]);

  // Cache for rendered SVGs — survives innerHTML resets
  const mermaidSvgCache = useRef<Map<number, string>>(new Map());

  // Reset cache when text changes
  useEffect(() => {
    mermaidSvgCache.current.clear();
  }, [text]);

  // Render new mermaid diagrams as their code blocks complete
  useEffect(() => {
    if (!containerRef.current) return;
    if (parsed.mermaidSources.length === 0) return;

    const containers = containerRef.current.querySelectorAll(
      ".mermaid-container[data-mermaid-idx]",
    );
    if (containers.length === 0) return;

    const currentContainer = containerRef.current;

    containers.forEach(async (el) => {
      const idx = parseInt(el.getAttribute("data-mermaid-idx") ?? "", 10);
      // Skip already rendered or in-flight
      if (renderedMermaidRef.current.has(idx)) return;
      if (renderingMermaidRef.current.has(idx)) return;

      const source = mermaidSourcesRef.current[idx];
      // Only render if this index also exists in the revealed parse
      // (meaning the full code block has been revealed)
      const revealedSource = parsed.mermaidSources[idx];
      if (!source || revealedSource === undefined) return;

      renderingMermaidRef.current.add(idx);
      ensureMermaidInit();

      const diagramEl = el.querySelector(".mermaid-diagram") as HTMLElement;
      if (!diagramEl) return;

      try {
        const id = `mermaid-${Date.now()}-${idx}`;
        const { svg } = await mermaid.render(id, source);
        renderedMermaidRef.current.add(idx);
        renderingMermaidRef.current.delete(idx);
        mermaidSvgCache.current.set(idx, svg);
        // Only update if DOM hasn't been replaced
        if (currentContainer === containerRef.current) {
          diagramEl.innerHTML = svg;
        }
      } catch (err) {
        renderedMermaidRef.current.add(idx);
        renderingMermaidRef.current.delete(idx);
        const errMsg =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "Unknown error";
        console.error(`[mermaid] Failed to render diagram ${idx}:`, err);
        const escapedMsg = errMsg
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        const errorHtml = `<span class="mermaid-error">Failed to render diagram: ${escapedMsg}</span>`;
        mermaidSvgCache.current.set(idx, errorHtml);
        if (currentContainer === containerRef.current) {
          diagramEl.innerHTML = errorHtml;
        }
      }
    });
  }, [parsed.html]);

  return <div ref={containerRef} class="markdown-body" />;
}
