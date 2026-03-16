import { useRef, useEffect, useMemo, useState } from "preact/hooks";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import mermaid from "mermaid";
import embed, { type VisualizationSpec } from "vega-embed";

type SpecialBlock =
  | { kind: "mermaid"; source: string }
  | { kind: "vega"; source: string }
  | { kind: "vega-lite"; source: string };

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
      primaryBorderColor: "#4EC9B0",
      secondaryColor: "#1e3a36",
      secondaryTextColor: "#e0e0e0",
      secondaryBorderColor: "#3ba89f",
      tertiaryColor: "#163330",
      tertiaryTextColor: "#e0e0e0",
      tertiaryBorderColor: "#2d7a72",
      lineColor: "#4EC9B0",
      textColor: "#e0e0e0",
      mainBkg: "#2a5e58",
      nodeBorder: "#4EC9B0",
      noteBkgColor: "#1e3a36",
      noteTextColor: "#e0e0e0",
      noteBorderColor: "#4EC9B0",
      actorBkg: "#2a5e58",
      actorBorder: "#4EC9B0",
      actorTextColor: "#e0e0e0",
      actorLineColor: "#4EC9B0",
      signalColor: "#e0e0e0",
      signalTextColor: "#e0e0e0",
      labelBoxBkgColor: "#1e3a36",
      labelBoxBorderColor: "#4EC9B0",
      labelTextColor: "#e0e0e0",
      loopTextColor: "#e0e0e0",
      activationBorderColor: "#4EC9B0",
      activationBkgColor: "#1e3a36",
      sequenceNumberColor: "#1a1a2e",
      pie1: "#4EC9B0",
      pie2: "#3ba89f",
      pie3: "#2d7a72",
      pie4: "#1e5c56",
      pie5: "#164e48",
      pie6: "#0e3d38",
      pie7: "#082e2a",
      pieTitleTextColor: "#e0e0e0",
      pieSectionTextColor: "#1a1a2e",
      git0: "#4EC9B0",
      git1: "#3ba89f",
      git2: "#2d7a72",
      git3: "#1e5c56",
      gitBranchLabel0: "#1a1a2e",
      gitBranchLabel1: "#1a1a2e",
      gitBranchLabel2: "#e0e0e0",
      gitBranchLabel3: "#e0e0e0",
      entityBorder: "#4EC9B0",
      entityBkg: "#2a5e58",
      entityTextColor: "#e0e0e0",
      relationColor: "#4EC9B0",
      attributeBackgroundColorEven: "#1e3a36",
      attributeBackgroundColorOdd: "#2a5e58",
    },
  });
}

const SPECIAL_FENCE_RE =
  /```(mermaid|vega-lite|vega)[^\r\n]*\r?\n([\s\S]*?)\r?\n```/g;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderSpecialBlockContainer(idx: number, block: SpecialBlock): string {
  const escapedCode = escapeHtml(block.source);
  const blockClass = block.kind === "mermaid" ? "mermaid" : "vega";
  const title =
    block.kind === "mermaid"
      ? "Diagram"
      : block.kind === "vega-lite"
        ? "Vega-Lite Chart"
        : "Vega Chart";
  return `<div class="special-block-container ${blockClass}-container" data-special-idx="${idx}" data-special-kind="${block.kind}"><div class="special-block-render ${blockClass}-render"><pre><code>${escapedCode}</code></pre></div><div class="special-block-actions ${blockClass}-actions"><button type="button" class="special-block-toggle-code">Show Code</button><button type="button" class="special-block-popout">Pop Out</button></div><pre class="special-block-source ${blockClass}-source" style="display:none"><code>${escapedCode}</code></pre><div class="special-block-sr-only">${title}</div></div>`;
}

function parseMarkdown(text: string): {
  html: string;
  specialBlocks: SpecialBlock[];
} {
  const specialBlocks: SpecialBlock[] = [];

  const localMarked = new Marked({
    renderer: {
      html({ text }: { text: string }) {
        return escapeHtml(text);
      },
      code({ text, lang }: { text: string; lang?: string }) {
        const langClass = lang ? ` class="language-${lang}"` : "";
        return `<pre><code${langClass}>${escapeHtml(text)}</code></pre>`;
      },
    },
  });

  let raw = "";
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  SPECIAL_FENCE_RE.lastIndex = 0;
  while ((match = SPECIAL_FENCE_RE.exec(text)) !== null) {
    const [fullMatch, kind, source] = match;
    const start = match.index;
    if (start > lastIndex) {
      raw += localMarked.parse(text.slice(lastIndex, start), {
        async: false,
      }) as string;
    }
    const idx = specialBlocks.length;
    specialBlocks.push({ kind: kind as SpecialBlock["kind"], source });
    raw += renderSpecialBlockContainer(idx, specialBlocks[idx]!);
    lastIndex = start + fullMatch.length;
  }

  if (lastIndex < text.length) {
    raw += localMarked.parse(text.slice(lastIndex), { async: false }) as string;
  }

  const html = DOMPurify.sanitize(raw, {
    ALLOWED_URI_REGEXP: /^(?:https?|vscode):/i,
    ADD_ATTR: ["data-special-idx", "data-special-kind"],
  });

  return { html, specialBlocks };
}

// Matches file paths like `src/foo/bar.ts`, `/abs/path.ts`, `src/foo.ts:42`
const FILE_PATH_RE =
  /(?<![:/])\b((?:(?:\/[\w.-]+)+|[\w][\w-]*(?:\/[\w.-]+)+)\.\w{1,8})(?::(\d+)(?:-\d+)?)?/g;

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
  onOpenSpecialBlockPanel?: (block: SpecialBlock) => void;
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
  onOpenSpecialBlockPanel,
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

  // Parse the FULL text to get stable special block sources (not affected by reveal animation)
  const fullParsed = useMemo(() => parseMarkdown(text), [text]);
  const specialBlocksRef = useRef<SpecialBlock[]>([]);
  specialBlocksRef.current = fullParsed.specialBlocks;

  // Parse the revealed portion for display
  const displayText = streaming ? text.slice(0, revealedLen) : text;
  const parsed = useMemo(() => parseMarkdown(displayText), [displayText]);

  // Track which special block indices have been rendered (survives across re-renders)
  const renderedSpecialBlocksRef = useRef<Set<number>>(new Set());
  // Track in-flight renders to avoid duplicates
  const renderingSpecialBlocksRef = useRef<Set<number>>(new Set());

  // Reset when the underlying text changes (new message)
  useEffect(() => {
    renderedSpecialBlocksRef.current.clear();
    renderingSpecialBlocksRef.current.clear();
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
      .querySelectorAll(".special-block-container[data-special-idx]")
      .forEach((el) => {
        const idx = parseInt(el.getAttribute("data-special-idx") ?? "", 10);
        const cached = specialBlockHtmlCache.current.get(idx);
        if (cached !== undefined) {
          const renderEl = el.querySelector(
            ".special-block-render",
          ) as HTMLElement;
          if (renderEl) renderEl.innerHTML = cached;
        }
      });

    containerRef.current
      .querySelectorAll(".special-block-toggle-code")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const container = btn.closest(".special-block-container");
          if (!container) return;
          const sourceEl = container.querySelector(
            ".special-block-source",
          ) as HTMLElement;
          if (!sourceEl) return;
          const hidden = sourceEl.style.display === "none";
          sourceEl.style.display = hidden ? "block" : "none";
          btn.textContent = hidden ? "Hide Code" : "Show Code";
        });
      });

    containerRef.current
      .querySelectorAll(".special-block-popout")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const container = btn.closest(".special-block-container");
          if (!container) return;
          const idx = parseInt(
            container.getAttribute("data-special-idx") ?? "",
            10,
          );
          const block = Number.isFinite(idx)
            ? specialBlocksRef.current[idx]
            : null;
          if (!block) return;
          onOpenSpecialBlockPanel?.(block);
        });
      });
  }, [parsed.html, onOpenSpecialBlockPanel, onOpenFile]);

  // Cache for rendered output — survives innerHTML resets
  const specialBlockHtmlCache = useRef<Map<number, string>>(new Map());

  // Reset cache when text changes
  useEffect(() => {
    specialBlockHtmlCache.current.clear();
  }, [text]);

  // Render special blocks as their code fences complete
  useEffect(() => {
    if (!containerRef.current) return;
    if (parsed.specialBlocks.length === 0) return;

    const containers = containerRef.current.querySelectorAll(
      ".special-block-container[data-special-idx]",
    );
    if (containers.length === 0) return;

    const currentContainer = containerRef.current;

    containers.forEach(async (el) => {
      const idx = parseInt(el.getAttribute("data-special-idx") ?? "", 10);
      if (renderedSpecialBlocksRef.current.has(idx)) return;
      if (renderingSpecialBlocksRef.current.has(idx)) return;

      const block = specialBlocksRef.current[idx];
      const revealedBlock = parsed.specialBlocks[idx];
      if (!block || revealedBlock === undefined) return;

      renderingSpecialBlocksRef.current.add(idx);

      const renderEl = el.querySelector(".special-block-render") as HTMLElement;
      if (!renderEl) return;

      try {
        let renderedHtml: string;
        if (block.kind === "mermaid") {
          ensureMermaidInit();
          const id = `mermaid-${Date.now()}-${idx}`;
          const { svg } = await mermaid.render(id, block.source);
          renderedHtml = svg;
        } else {
          const spec = JSON.parse(block.source) as VisualizationSpec;
          const tmp = document.createElement("div");
          await embed(tmp, spec, {
            actions: false,
            renderer: "svg",
            mode: block.kind,
            theme: "dark",
          });
          renderedHtml = tmp.innerHTML;
        }

        renderedSpecialBlocksRef.current.add(idx);
        renderingSpecialBlocksRef.current.delete(idx);
        specialBlockHtmlCache.current.set(idx, renderedHtml);
        if (currentContainer === containerRef.current) {
          renderEl.innerHTML = renderedHtml;
        }
      } catch (err) {
        renderedSpecialBlocksRef.current.add(idx);
        renderingSpecialBlocksRef.current.delete(idx);
        const errMsg =
          err instanceof Error
            ? err.message
            : typeof err === "string"
              ? err
              : "Unknown error";
        const label = block.kind === "mermaid" ? "diagram" : "chart";
        console.error(`[${block.kind}] Failed to render ${label} ${idx}:`, err);
        const errorHtml = `<span class="special-block-error">Failed to render ${label}: ${escapeHtml(errMsg)}</span>`;
        specialBlockHtmlCache.current.set(idx, errorHtml);
        if (currentContainer === containerRef.current) {
          renderEl.innerHTML = errorHtml;
        }
      }
    });
  }, [parsed.html, parsed.specialBlocks]);

  return <div ref={containerRef} class="markdown-body" />;
}
