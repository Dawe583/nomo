import { ProviderNotice, RunStatus } from "./workspace-status";
import { providerStatus, runState, runCanStop, runBlocksInput } from "./workspace-state";
import { SessionContext } from "./session-context";
import { SessionRecoveryStatus } from "./recovery-dialog";
import { agentOptions, sessionAgent } from "./agent-input";
import { loadDraft, saveDraft, submitDraft } from "./draft-state";
import { CommandMenu } from "./command-menu.tsx";
import { filterCommands, toolPrompt, type Command } from "./commands.ts";
import * as m from "motion/react-m";
import { BrandMark } from "./brand";
import { ApprovalReview } from "./approval-review";
import { Icon } from "./icons";
import {
  PermissionBanner,
  PermissionModeSwitch,
  modePrefix,
  usePermissionMode,
} from "./permission-mode.tsx";
import { lastUserMessage, transcriptEvents, usageSummary } from "./events";
import {
  Children,
  useContext,
  isValidElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, download, json, type Row } from "./api";
import { statusLabel } from "./status-label.ts";
import { formatDuration, streamPhase, toolDuration, toolTimings, type ToolTiming } from "./chat-stream";
import {
  ATTACHMENT_BYTE_LIMIT,
  BUDGET_VISIBLE_AT,
  clearDraftFiles,
  MESSAGE_BYTE_LIMIT,
  MESSAGE_CHAR_LIMIT,
  attachmentBytes,
  loadDraftFiles,
  messageSize,
  saveDraftFiles,
  type DraftFile,
} from "./chat-composer";
import { Badge, Dialog, Empty, ErrorBox, MotionEnabled, RedactedJson, useApi, useText } from "./ui";
import "./chat.css";
// VOID has no default model. The composer starts empty; the operator's saved
// preference or the provider's validated catalog fills it in.
function CodeBlock({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLPreElement>(null),
    [wrap, setWrap] = useState(false),
    [highlight, setHighlight] = useState("");
  const t = useText();
  const child = Children.toArray(children).find(isValidElement);
  const props = child?.props as
    { className?: string; children?: ReactNode } | undefined;
  const language = props?.className?.replace("language-", "") ?? "text";
  const source = String(props?.children ?? "");
  useEffect(() => {
    let active = true;
    if (language === "text") return;
    void import("highlight.js/lib/common")
      .then(({ default: hljs }) => {
        if (active && hljs.getLanguage(language))
          setHighlight(
            hljs.highlight(source, { language, ignoreIllegals: true }).value,
          );
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [source, language]);
  return (
    <div className="code-block">
      <div className="code-actions">
        <span>{language}</span>
        <button onClick={() => navigator.clipboard.writeText(source)}>
          {t("Kopírovat", "Copy")}
        </button>
        <button onClick={() => setWrap(!wrap)} aria-pressed={wrap}>
          {t("Zalamovat", "Wrap")}
        </button>
        <button
          onClick={() =>
            download("code." + (language === "text" ? "txt" : language), source)
          }
        >
          {t("Stáhnout", "Download")}
        </button>
      </div>
      <pre ref={ref} style={{ whiteSpace: wrap ? "pre-wrap" : "pre" }}>
        {highlight ? (
          <code dangerouslySetInnerHTML={{ __html: highlight }} />
        ) : (
          children
        )}
      </pre>
    </div>
  );
}
export function RichText({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        pre: CodeBlock,
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
      }}
    >
      {text}
    </Markdown>
  );
}

/** The two tool lifecycle states the shared `status-label.ts` table does not
 * carry. These are hand-transcribed strings, not derived from the events: the
 * keys are the `status` values `events.ts` writes when it merges a
 * `tool.started` with a `tool.result`. Rename one there and it falls through
 * to `statusLabel`, which has no entry and returns the raw token. Both files
 * have to change together. */
const TOOL_LIFECYCLE: Record<string, [string, string]> = {
  requested: ["probíhá", "running"],
  completed: ["dokončeno", "completed"],
};

function toolStatusLabel(value: unknown, t: (cs: string, en: string) => string) {
  const lifecycle = TOOL_LIFECYCLE[String(value ?? "")];
  return lifecycle ? t(lifecycle[0], lifecycle[1]) : statusLabel(value, t);
}

/** A tool card is read at two different moments: while the call is in flight,
 * when the arguments matter and the result does not exist yet, and after it
 * settled, when the arguments are detail and the outcome and duration are the
 * point. The same markup carries both, so a reader never has to guess which
 * one they are looking at. */
function ToolCard({
  event,
  text,
  timing,
}: {
  event: Row;
  text: string;
  timing?: ToolTiming;
}) {
  const t = useText();
  const card = useRef<HTMLDetailsElement>(null);
  const status = String(event.payload?.status ?? event.kind ?? event.type ?? "");
  const live = status === "requested";
  const duration = formatDuration(toolDuration(timing));
  const tool = String(event.payload?.tool ?? text.slice(0, 100) ?? "");
  useEffect(() => {
    // Open on arrival so an in-flight call is visible without a click, and
    // never force it shut afterwards: once it is settled the user decides.
    if (live) card.current?.setAttribute("open", "");
  }, [live]);
  return (
    <details
      className="tool-card"
      ref={card}
      data-phase={live ? "running" : "settled"}
      aria-busy={live || undefined}
    >
      <summary>
        <span className="tool-glyph" aria-hidden="true">⌘</span>
        <span className="tool-name">{tool}</span>
        {live && <span className="tool-pulse" aria-hidden="true" />}
        <Badge value={status}>{toolStatusLabel(status, t)}</Badge>
        {duration && (
          <span className="tool-duration">
            {t("trvala", "took")} {duration}
          </span>
        )}
      </summary>
      {live && (
        <p className="tool-pending">
          {t(
            "Volání běží. Výsledek ani změnu stavu zatím nelze potvrdit.",
            "The call is running. Neither a result nor a state change is confirmed yet.",
          )}
        </p>
      )}
      {text ? <div className="tool-result"><RichText text={text} /></div> : null}
      {event.payload ? <RedactedJson value={event.payload} /> : null}
    </details>
  );
}
export function Chat({
  id,
  navigate,
  onContext,
}: {
  id?: string;
  navigate: (path: string) => void;
  onContext: () => void;
}) {
  const animate = useContext(MotionEnabled);
  const t = useText(),
    client = useQueryClient();
  const sessionQuery = useApi(
    "/api/sessions/" + id + "?events=false",
    !!id,
    (data) => (data?.session?.status === "running" ? 5000 : 15000),
  );
  const provider = useApi("/api/provider");
  const preferences = useApi("/api/preferences");
  const capabilities = useApi("/api/capabilities");
  const agents = useApi("/api/agents", !id);
  const projects = useApi("/api/projects", !id && capabilities.data?.projects === true);
  const [agent, setAgent] = useState<string>();
  const selectedAgent = sessionAgent(agent, preferences.data?.preferences, capabilities.data?.mode, agents.data);
  const workspace = useApi("/api/sessions/" + id + "/workspace", !!id);
  const holds = useApi("/api/approvals", !!id, 3000);
  const perm = usePermissionMode(capabilities, preferences);
  const [contextPicker, setContextPicker] = useState(false);
  const [chatOptions, setChatOptions] = useState(false);
  const [approval, setApproval] = useState<Row>();
  const session = sessionQuery.data?.session;
  const providerEndpoint = id ? session?.provider : provider.data?.baseUrl;
  const providerLabel =
    session?.providerName ??
    provider.data?.presets?.find(
      (preset: Row) => preset.baseUrl === providerEndpoint,
    )?.name ??
    providerEndpoint ??
    t("Poskytovatel neověřen", "Provider unverified");
  const running = runBlocksInput(session);
  const state = runState(session);
  const search = new URLSearchParams(location.search);
  const draftKey = "void-draft:" + search.get("workspace") + ":" + (id ?? "new");
  const [draft, setDraft] = useState(
    () => loadDraft(sessionStorage, draftKey).text,
  );
  const [project, setProject] = useState(
    () => search.get("project")?.slice(0, 160) ?? "",
  );
  const [background, setBackground] = useState(false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const composerWrap = useRef<HTMLDivElement>(null);
  const chatSection = useRef<HTMLElement>(null);
  const [model, setModel] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("void-model-favorites") ?? "[]");
    } catch {
      return [];
    }
  });
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [branch, setBranch] = useState<Row>();
  const [retry, setRetry] = useState(false);
  const branchRequestKey = useRef<string | undefined>(undefined);
  function selectBranch(event: Row, shouldRetry = false) {
    branchRequestKey.current = crypto.randomUUID();
    setRetry(shouldRetry);
    setBranch(event);
  }
  const [now, setNow] = useState(Date.now());
  const [edited, setEdited] = useState("");
  const [attachments, setAttachments] = useState<DraftFile[]>([]);
  // Mirrors `attachments` so the persistence effect can read the value that
  // belongs to the current draft key even inside the restoring commit.
  const attachmentsRef = useRef<DraftFile[]>(attachments);
  attachmentsRef.current = attachments;
  // One prompt and one set of bounds. The budget line under the input and the
  // send guard read this same string, so the number on screen can never
  // disagree with the limit that blocks the message.
  const prompt =
    modePrefix(perm.mode, t) +
    draft +
    (attachments.length
      ? "\n\n" +
        attachments
          .map((a) => "--- " + a.name + " ---\n" + a.content)
          .join("\n\n")
      : "");
  const size = messageSize(prompt);
  const attachmentTotal = attachmentBytes(attachments);
  // The budget appears only once the prompt is close enough to a bound to
  // matter, so an ordinary draft never pays for a warning it does not need.
  const budget =
    size.pressure < BUDGET_VISIBLE_AT
      ? null
      : size.over
        ? t(
            "Překročen limit: " +
              size.chars.toLocaleString() +
              " znaků a " +
              size.bytes.toLocaleString() +
              " B. Zkraťte zprávu nebo odeberte přílohu.",
            "Over the limit: " +
              size.chars.toLocaleString() +
              " characters and " +
              size.bytes.toLocaleString() +
              " B. Shorten the message or remove an attachment.",
          )
        : t(
            "Do limitu zbývá " +
              (MESSAGE_CHAR_LIMIT - size.chars).toLocaleString() +
              " znaků nebo " +
              (MESSAGE_BYTE_LIMIT - size.bytes).toLocaleString() +
              " B.",
            "Before the limit: " +
              (MESSAGE_CHAR_LIMIT - size.chars).toLocaleString() +
              " characters or " +
              (MESSAGE_BYTE_LIMIT - size.bytes).toLocaleString() +
              " B.",
          );
  const [newMessages, setNewMessages] = useState(false);
  const [follow, setFollow] = useState(true);
  const [commandDismissed, setCommandDismissed] = useState(false);
  const [commandIndex, setCommandIndex] = useState(0);
  const [selectedTool, setSelectedTool] = useState<Command>();
  const [queued, setQueued] = useState(() => loadDraft(sessionStorage, draftKey).queued);
  const commandOpen =
    draft.startsWith("/") && !/\s/.test(draft) && !commandDismissed;
  const toolsQuery = useApi(
    "/api/tools" + (id ? "?session=" + encodeURIComponent(id) : ""),
    commandOpen,
  );
  const commands: Command[] = [
    {
      id: "new",
      name: "new",
      description: t("Nová konverzace", "New conversation"),
    },
    {
      id: "plan",
      name: "plan",
      description: t(
        "Připravit plán před provedením změn",
        "Request a plan before making changes",
      ),
    },
    {
      id: "review",
      name: "review",
      description: t(
        "Zkontrolovat výstupy a rizika",
        "Review outputs and risks",
      ),
    },
    {
      id: "tools",
      name: "tools",
      description: t(
        "Připojené nástroje a jejich konfigurace",
        "Connected tools and configuration",
      ),
    },
    {
      id: "model",
      name: "model",
      description: t(
        "Vybrat model pro novou konverzaci",
        "Choose a model for a new conversation",
      ),
    },
    {
      id: "context",
      name: "context",
      description: t(
        "Dokumenty, revize a kontext",
        "Documents, revisions and context",
      ),
    },
    {
      id: "undo",
      name: "undo",
      description: t(
        "Otevřít zachycené změny a náhled Undo",
        "Open captured changes and Undo preview",
      ),
    },
    {
      id: "approvals",
      name: "approvals",
      description: t(
        "Rozhodnutí čekající na schválení",
        "Pending approval decisions",
      ),
    },
    {
      id: "ledger",
      name: "ledger",
      description: t(
        "Podepsaný audit operací VOID",
        "VOID signed operation audit",
      ),
    },
    ...(id
      ? [
          {
            id: "export",
            name: "export",
            description: t(
              "Stáhnout načtený přepis jako Markdown",
              "Download the loaded transcript as Markdown",
            ),
          },
        ]
      : []),
    ...(running
      ? [
          {
            id: "stop",
            name: "stop",
            description: t(
              "Zastavit aktivního agenta",
              "Stop the active agent",
            ),
          },
        ]
      : []),
    ...(toolsQuery.data?.tools ?? []).map((tool: Command) => ({
      ...tool,
      tool: true,
      description: `${tool.source} · ${tool.description}`,
    })),
  ];
  const commandItems = filterCommands(commands, draft);
  const activeCommand = Math.min(
    commandIndex,
    Math.max(0, commandItems.length - 1),
  );
  async function chooseCommand(command: Command) {
    setCommandDismissed(true);
    setDraft("");
    setCommandIndex(0);
    if (command.tool) {
      setSelectedTool(command);
      setDraft(toolPrompt(command));
    } else if (command.id === "plan")
      setDraft(
        t(
          "Nejprve navrhni plán, upozorni na rizika a vyčkej na mé schválení před změnami. Úkol: ",
          "First propose a plan, identify risks, and wait for my approval before making changes. Task: ",
        ),
      );
    else if (command.id === "review")
      setDraft(
        t(
          "Zkontroluj následující práci. Uveď konkrétní nálezy, důkazy a doporučené opravy. Bez provádění změn. Předmět kontroly: ",
          "Review the following work. Give concrete findings, evidence and suggested fixes. Do not make changes. Review: ",
        ),
      );
    else if (command.id === "new") navigate("/chat");
    else if (command.id === "tools") navigate("/connections");
    else if (command.id === "model") {
      if (id) navigate("/models");
      else setPicker(true);
    } else if (command.id === "context" || command.id === "undo") onContext();
    else if (command.id === "export")
      download(
        "void-transcript-" + id + ".md",
        events.map((event) => `## ${event.kind}\n\n${event.text}`).join("\n\n"),
        "text/markdown",
      );
    else if (command.id === "stop") await stopRun();
    else navigate("/" + command.id);
    textarea.current?.focus();
  }
  const requestKey = useRef<{ prompt: string; key: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    const saved = loadDraft(sessionStorage, draftKey);
    setDraft(saved.text);
    setQueued(saved.queued);
    // The draft text survives a route change, so its attachments have to as
    // well. Restoring one without the other would send a different message
    // than the one the composer shows.
    const files = loadDraftFiles(sessionStorage, draftKey);
    attachmentsRef.current = files;
    setAttachments(files);
    setSelectedTool(undefined);
    setCommandDismissed(false);
    setFollow(true);
    // Defence in depth, not a live fix. `main.tsx:857` mounts Chat with
    // `key={chatId ?? "new"}` and ui.test.ts pins that, so a /chat/A -> /chat/B
    // switch does remount and a branch dialog cannot survive it. An earlier
    // review claimed the opposite on the strength of PageComponent, which
    // chat never goes through; it does not. Resetting the branch state here
    // costs nothing and keeps the effect that owns this component's
    // conversation-scoped state from being the one place it does not.
    setBranch(undefined);
    setRetry(false);
    setEdited("");
  }, [draftKey]);
  useEffect(() => {
    // The ref, not the state: on a key change this effect runs in the same
    // commit as the restore above and would otherwise write the previous
    // conversation's files under the new key.
    saveDraftFiles(sessionStorage, draftKey, attachmentsRef.current);
  }, [attachments, draftKey]);
  useEffect(() => {
    saveDraft(sessionStorage, draftKey, draft, queued);
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height =
        Math.min(156, textarea.current.scrollHeight) + "px";
    }
  }, [draft, draftKey, queued]);
  useEffect(() => {
    if (preferences.data?.preferences?.defaultModel)
      setModel(preferences.data.preferences.defaultModel);
  }, [preferences.data]);
  const [eventBuffer, setEventBuffer] = useState<Row[]>([]);
  const [historyComplete, setHistoryComplete] = useState(true);
  const rawEvents = eventBuffer.length ? eventBuffer : (session?.events ?? []);
  const events = transcriptEvents(rawEvents);
  const streaming = streamPhase(rawEvents);
  const timings = toolTimings(rawEvents);
  const usage = usageSummary(rawEvents);
  const latestError = [...eventBuffer]
    .reverse()
    .find((event: Row) => event.type === "run.error");
  const retryAt = Date.parse(latestError?.payload?.retryAt ?? "");
  const retryWait = Number.isFinite(retryAt)
    ? Math.max(0, Math.ceil((retryAt - now) / 1000))
    : 0;
  useEffect(() => {
    if (!retryWait) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryWait]);
  useEffect(() => {
    if (!id) return;
    let disposed = false,
      fetching = false,
      after = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let eventTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingEvents: Row[] = [];
    const merge = (incoming: Row[]) => {
      if (disposed || !incoming.length) return;
      setEventBuffer((previous) =>
        [
          ...new Map(
            [...previous, ...incoming].map((event) => [event.seq, event]),
          ).values(),
        ].sort((a, b) => a.seq - b.seq),
      );
    };
    const refresh = () => {
      if (timer) return;
      timer = setTimeout(() => {
        void client.invalidateQueries({
          queryKey: ["/api/sessions/" + id + "?events=false"],
        });
        timer = undefined;
      }, 500);
    };
    async function sync() {
      if (fetching || disposed || document.hidden) return;
      fetching = true;
      try {
        let more = true;
        while (more && !disposed) {
          const result = await api(
            "/api/sessions/" + id + "/events?after=" + after,
          );
          const incoming = result.items ?? [];
          merge(incoming);
          if (after === 0) setHistoryComplete(result.historyComplete !== false);
          const next = Number(result.nextAfter ?? result.after ?? after);
          more = !!result.hasMore && next > after;
          after = next;
        }
      } catch {
        /* Session query exposes connection errors while incremental reads retry. */
      } finally {
        fetching = false;
      }
    }
    const stream = new EventSource(
      "/api/sessions/" + encodeURIComponent(id) + "/stream",
    );
    stream.onmessage = (event) => {
      try {
        const incoming = JSON.parse(event.data);
        pendingEvents.push(incoming);
        if (
          ["run.status", "run.error", "message.completed"].includes(
            incoming.type,
          )
        )
          refresh();
        if (["document.changed", "tool.result"].includes(incoming.type))
          void client.invalidateQueries({
            predicate: (query) => {
              const key = String(query.queryKey[0]);
              return (
                key.startsWith("/api/documents") ||
                key.startsWith("/api/sessions/" + id + "/workspace") ||
                key.startsWith("/api/sessions/" + id + "/documents")
              );
            },
          });
        if (!eventTimer)
          eventTimer = setTimeout(() => {
            merge(pendingEvents);
            pendingEvents = [];
            eventTimer = undefined;
          }, 100);
      } catch {
        void sync();
      }
    };
    stream.onerror = () => {
      void sync();
    };
    const poll = setInterval(() => void sync(), 5000);
    void sync();
    return () => {
      disposed = true;
      stream.close();
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      if (eventTimer) clearTimeout(eventTimer);
    };
  }, [id, client]);
  // Anchoring runs before paint. Applied after the frame, an autoscroll is a
  // visible jump on every streamed fragment. `follow` means the reader is at
  // the end, so scrolling up is never fought and the transcript keeps its
  // place while history is read.
  useLayoutEffect(() => {
    const el = transcript.current;
    if (!el || !follow) return;
    el.scrollTop = el.scrollHeight;
    setNewMessages(false);
  }, [events.length, events.at(-1)?.text, follow]);
  // Content can grow without a new event: a Markdown table, a code block, an
  // entering message. Re-anchor so the newest line stays in view while the
  // reader is following. When they are not, only growth is news: a webfont
  // load, a window resize or a details toggle must not raise the pill.
  useEffect(() => {
    const el = transcript.current;
    const content = el?.firstElementChild;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    let height = el.scrollHeight;
    const observer = new ResizeObserver(() => {
      const grown = el.scrollHeight > height;
      height = el.scrollHeight;
      if (follow) {
        el.scrollTop = el.scrollHeight;
        setNewMessages(false);
        return;
      }
      if (grown) setNewMessages(true);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [follow]);
  // The composer grows with the draft and with the notices above it. The pill
  // is positioned from the measured height instead of a fixed guess, so it
  // cannot land on top of the input it is meant to sit above.
  useEffect(() => {
    const wrap = composerWrap.current;
    const section = chatSection.current;
    if (!wrap || !section) return;
    const apply = () =>
      section.style.setProperty(
        "--composer-offset",
        Math.round(wrap.getBoundingClientRect().height) + "px",
      );
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);
  // Scrolling back to the end by hand is a decision to follow again. Without
  // this the pill stays on screen above a line the reader is already looking
  // at, and it survives until the next event happens to arrive.
  function onTranscriptScroll() {
    const el = transcript.current;
    if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setFollow(atEnd);
    if (atEnd) setNewMessages(false);
  }
  // Esc in the composer requests a real run cancellation on the server.
  // Overlay dismissal keeps priority: an open slash menu or dialog consumes
  // Esc before this branch ever runs.
  async function stopRun() {
    if (!id || busy || !runCanStop(session)) return;
    // The Stop control exists only while a run is live, so it unmounts the
    // moment the run ends. Hand the keyboard back to the composer instead of
    // dropping focus on the document body, the same way the /stop command does.
    setBusy(true);
    try {
      await api("/api/runs/" + encodeURIComponent(id) + "/stop", "POST");
      await client.invalidateQueries();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      textarea.current?.focus();
    }
  }
  async function send() {
    if (commandOpen) {
      if (commandItems[activeCommand])
        await chooseCommand(commandItems[activeCommand]);
      return;
    }
    if (!draft.trim()) {
      setQueued(false);
      return;
    }
    if (busy || retryWait > 0 || (id && !session) || (!id && (providerStatus(provider.data) !== "ready" || !selectedAgent))) return;
    if (id && state === "unknown") {
      setError(t("Nejprve ověřte výsledek předchozího běhu.", "Check the previous run outcome before sending."));
      return;
    }
    if (running) {
      saveDraft(sessionStorage, draftKey, draft, true);
      setQueued(true);
      return;
    }
    setBusy(true);
    setError(undefined);
    // The prefix is only a legible model instruction. The server remains
    // authoritative: it filters the tool catalog and refuses mutations.
    if (size.over) {
      setError(
        t(
          "Zpráva s přílohami přesahuje limit 32 000 znaků nebo 60 KB. Zkraťte ji.",
          "Message and attachments exceed 32,000 characters or 60 KB. Shorten it.",
        ),
      );
      setBusy(false);
      return;
    }
    if (!requestKey.current || requestKey.current.prompt !== prompt)
      requestKey.current = { prompt, key: crypto.randomUUID() };
    const idempotencyKey = requestKey.current.key;
    try {
      const result = await submitDraft(sessionStorage, draftKey, () => api(
        id ? "/api/sessions/" + id : "/api/sessions",
        "POST",
        {
          prompt,
          model: session?.model ?? model,
          ...(id
            ? {}
            : {
                project: capabilities.data?.projects === true ? project.trim() || undefined : undefined,
                agent: selectedAgent,
                background,
              }),
          idempotencyKey,
        },
      ));
      // The draft text is cleared inside submitDraft; the attachments have to
      // be cleared here, imperatively, so an unmount or a route change
      // between now and the next effect cannot leave them behind.
      clearDraftFiles(sessionStorage, draftKey);
      setQueued(false);
      setDraft("");
      setSelectedTool(undefined);
      setAttachments([]);
      requestKey.current = undefined;
      setFollow(true);
      await client.invalidateQueries();
      if (!id) navigate("/chat/" + result.session.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function fork() {
    if (!branch || !id) return;
    setBusy(true);
    try {
      const result = await api("/api/sessions/" + id + "/branches", "POST", {
        seq: branch.seq,
        ...(branch.kind === "user" ? { prompt: edited } : {}),
        snapshotDocuments: true,
        idempotencyKey: branchRequestKey.current,
      });
      if (retry)
        await api("/api/sessions/" + result.session.id, "POST", {
          prompt: t(
            "Odpověz na předchozí uživatelskou zprávu.",
            "Respond to the preceding user message.",
          ),
          idempotencyKey: `${branchRequestKey.current}:followup`,
        });
      setBranch(undefined);
      setRetry(false);
      navigate("/chat/" + result.session.id);
      await client.invalidateQueries();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const models: Row[] = provider.data?.models ?? [];
  const catalog = models;
  return (
    <section
      className={"chat " + (!id ? "chat-empty" : "chat-active")}
      ref={chatSection}
    >
      <div className="transcript" ref={transcript} onScroll={onTranscriptScroll}>
        <div className="messages">
          {!id && (
            <m.div
              className="welcome"
              initial={animate ? { opacity: 0, y: 12 } : false}
              animate={{ opacity: 1, y: 0 }}
            >
              <BrandMark />
              <h1>
                {t(
                  "Prostor pro vaše další myšlenky.",
                  "Room for your next idea.",
                )}
              </h1>
              <p>
                {t(
                  "Pište, tvořte a mějte přehled o každém kroku.",
                  "Write, build, and keep every step in view.",
                )}
              </p>
              <div className="starters">
                {[
                  [
                    t("Připravit projekt", "Plan a project"),
                    t(
                      "Vytvoř stručný projektový plán a ulož ho do plan.md.",
                      "Create a concise project plan and save it to plan.md.",
                    ),
                  ],
                  [
                    t("Prozkoumat možnosti", "Explore tools"),
                    t(
                      "Jaké nástroje mám k dispozici? Vysvětli jejich použití.",
                      "Which tools are available? Explain how to use them.",
                    ),
                  ],
                  [
                    t("Začít dokument", "Start a document"),
                    t(
                      "Pomoz mi vytvořit strukturu nového dokumentu.",
                      "Help me outline a new document.",
                    ),
                  ],
                ].map(([label, prompt], index) => (
                  <m.button
                    initial={animate ? { opacity: 0, y: 8 } : false}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: animate ? 0.3 : 0,
                      delay: animate ? 0.1 + index * 0.05 : 0,
                    }}
                    whileTap={animate ? { scale: 0.97 } : undefined}
                    key={label}
                    onClick={() => {
                      setDraft(prompt);
                      textarea.current?.focus();
                    }}
                  >
                    <span className="starter-copy">
                      <strong>{label}</strong>
                      <span>{prompt}</span>
                    </span>
                    <span className="starter-arrow" aria-hidden="true">
                      ↗
                    </span>
                  </m.button>
                ))}
              </div>
            </m.div>
          )}
          <ErrorBox error={sessionQuery.error} />
          {id && sessionQuery.isError && (
            <p className="notice">
              {t(
                "Přepis této konverzace není dostupný. Koncept zůstává uložený v tomto okně.",
                "This transcript is not available. Your draft stays saved in this tab.",
              )}{" "}
              <button type="button" onClick={() => navigate("/sessions")}>
                {t("Otevřít přehled konverzací", "Open conversation history")}
              </button>
            </p>
          )}
          {!historyComplete && (
            <p className="notice">
              {t(
                "Starší část historie nebyla serverem zachována.",
                "An older portion of this history was not retained by the server.",
              )}
            </p>
          )}
          {sessionQuery.isLoading && id && (
            <div className="chat-loading" role="status">
              <p>{t("Načítání konverzace…", "Loading conversation…")}</p>
              <span className="skeleton-line skeleton-lead" />
              <span className="skeleton-line" />
              <span className="skeleton-line skeleton-long" />
              <span className="skeleton-block" />
              <span className="skeleton-line skeleton-short" />
            </div>
          )}
          {id &&
            !sessionQuery.isLoading &&
            !sessionQuery.isError &&
            !events.length && (
              <Empty>
                {t(
                  "Tato konverzace zatím nemá žádné zprávy. Níže můžete napsat první zprávu nebo koncept uložit bez odeslání.",
                  "This conversation has no messages yet. Write the first one below, or keep a draft without sending it.",
                )}
              </Empty>
            )}
          {events.map((event, index) => {
            const kind = event.kind ?? event.type ?? "event";
            const text = event.text ?? event.payload?.text ?? "";
            const isTool = kind.includes("tool") || kind === "decision";
            // Provisional text needs both an open delta run and a run that
            // still accepts input. Without the second half a stop, a failure
            // or a truncated history would leave the last answer badged
            // "arriving" with its actions suppressed, and the user could not
            // copy, branch from or retry the answer they just asked for.
            const arriving =
              running &&
              streaming.streaming &&
              index === events.length - 1 &&
              !isTool;
            return (
              <m.article
                initial={animate ? { opacity: 0, y: 6 } : false}
                animate={{ opacity: 1, y: 0 }}
                key={event.id ?? event.seq ?? index}
                aria-busy={arriving || undefined}
                className={
                  "message " +
                  (kind === "user" ? "user" : isTool ? "tool" : "assistant") +
                  (arriving ? " arriving" : "")
                }
              >
                <div className="message-label">
                  <span>
                    {kind === "user"
                      ? t("Vy", "You")
                      : kind === "assistant"
                        ? "VOID"
                        : kind}
                  </span>
                  {arriving && (
                    // A live region of its own, because the run status below
                    // is anchored on `running` and a stop clears that while
                    // the text is still settling. It enters once and leaves
                    // once, so it is announced twice, not per token.
                    <span
                      className="stream-flag"
                      data-stream="true"
                      role="status"
                    >
                      <span className="stream-caret" aria-hidden="true" />
                      {t("právě dorazí", "arriving")}
                    </span>
                  )}
                  <time dateTime={event.at}>
                    {new Date(event.at).toLocaleTimeString(
                      t("cs-CZ", "en-GB"),
                      { hour: "2-digit", minute: "2-digit" },
                    )}
                  </time>
                </div>
                {isTool ? (
                  <ToolCard
                    event={event}
                    text={text}
                    timing={timings.get(String(event.payload?.callId ?? ""))}
                  />
                ) : (
                  <div className="prose">
                    <RichText text={text} />
                  </div>
                )}
                {/* Copying, branching from or retrying a message that is still
                    arriving would act on text the server has not settled. */}
                {text && !arriving && (
                  <div className="message-actions">
                    <button onClick={() => navigator.clipboard.writeText(text)}>
                      {t("Kopírovat", "Copy")}
                    </button>
                    {(kind === "user" || kind === "assistant") && (
                      <button
                        disabled={running}
                        onClick={() => {
                          selectBranch(event);
                          setEdited(kind === "user" ? text : "");
                        }}
                      >
                        {kind === "user"
                          ? t("Upravit ve větvi", "Edit as branch")
                          : t("Vytvořit větev", "Branch here")}
                      </button>
                    )}
                    {kind === "assistant" && (
                      <button
                        disabled={running || retryWait > 0}
                        onClick={() => {
                          const user = events
                            .slice(0, index)
                            .reverse()
                            .find((e) => e.kind === "user");
                          if (user) {
                            selectBranch(user, true);
                            setEdited(user.text);
                          }
                        }}
                      >
                        {t("Zkusit znovu", "Retry")}
                      </button>
                    )}
                  </div>
                )}
              </m.article>
            );
          })}
          {running && (
            <p className="run-status" role="status">
              <span className="activity-dot" />{" "}
              {session && <RunStatus run={session} />}
              {state === "stopping" && t(" Odeslaný nástroj může ještě dokončit práci.", " An issued tool may still finish.")}
            </p>
          )}
          {session && <SessionContext key={session.id} session={session} events={rawEvents} supported={capabilities.data?.contextCompaction === true} />}
        </div>
      </div>
      {newMessages && !follow && (
        <button
          className="new-messages"
          onClick={() => {
            setFollow(true);
            textarea.current?.focus();
          }}
        >
          {t("Nové zprávy ↓", "New messages ↓")}
        </button>
      )}
      <div className="composer-wrap" ref={composerWrap}>
        <div className="composer-notices" tabIndex={0} role="region" aria-live="polite" aria-label={t("Stav a upozornění", "Status and notices")}>
        {retryWait > 0 && (
          <p className="notice" role="status">
            {t(
              "Limit poskytovatele. Další pokus za",
              "Provider rate limit. Retry in",
            )}{" "}
            {retryWait} s.
          </p>
        )}
        {(holds.data?.approvals ?? [])
          .filter(
            (a: Row) =>
              a.status === "pending" &&
              a.call?.workspace === session?.workspace,
          )
          .map((a: Row) => (
            <div className="inline-approval" key={a.holdId}>
              <span>
                {t("Vyžaduje rozhodnutí", "Needs a decision")}:{" "}
                <strong>{a.call?.tool}</strong>
              </span>
              <button onClick={() => setApproval(a)}>
                {t("Zkontrolovat a rozhodnout", "Review and decide")}
              </button>
            </div>
          ))}
        <ErrorBox error={error ?? provider.error} />
        <PermissionBanner mode={perm.mode} source={perm.source} />
        {!id && <ProviderNotice provider={provider.data} setup={() => navigate("/settings")} />}
        {id && state === "unknown" && <p className="notice" role="status">{t("Výsledek běhu není potvrzen. Před dalším pokusem zkontrolujte běh a ledger.", "The run outcome is not confirmed. Check the run and ledger before retrying.")}</p>}
        {queued && (
          <div className="queue-banner" role="status">
            <span className="queue-banner-text">
              {t(
                "Koncept je uložený v této kartě. Nic se neodešle automaticky.",
                "Draft saved in this tab. Nothing sends automatically.",
              )}
            </span>
            <button
              disabled={busy || running || retryWait > 0 || !draft.trim() || size.over}
              onClick={() => void send()}
            >
              {t("Odeslat koncept", "Send draft")}
            </button>
          </div>
        )}
        {session && <>
          <SessionRecoveryStatus key={"recovery:" + session.id} session={session} />

        </>}

          {selectedTool && (
            <details className="selected-tool">
              <summary>
                <strong>{selectedTool.name}</strong>
                <span className="selected-tool-class">
                  {selectedTool.capturedUndo
                    ? t("r1 · vratná změna", "r1 · reversible")
                    : selectedTool.klass === "r0"
                      ? t("r0 · čtení", "r0 · read")
                      : t("podle VOID policy", "by VOID policy")}
                </span>
                <span className="selected-tool-hint">
                  {t("jen připraveno", "prepared only")}
                </span>
              </summary>
              <p>{selectedTool.description}</p>
              <pre>{json(selectedTool.inputSchema)}</pre>
              <p>
                {t(
                  "Požadavek vykoná agent přes běžné schvalování VOID. Dostupnost neznamená oprávnění.",
                  "The agent handles this request through normal VOID approval. Availability is not permission.",
                )}
              </p>
            </details>
          )}
          {attachments.length > 0 && (
            <div className="attachments">
              {attachments.map((a, i) => (
                <span key={a.name}>
                  {a.name} <small>{a.bytes} B</small>
                  <button
                    type="button"
                    aria-label={t("Odebrat přílohu", "Remove attachment") + " " + a.name}
                    onClick={() =>
                      setAttachments(attachments.filter((_, n) => n !== i))
                    }
                  >
                    ×
                  </button>
                </span>
              ))}
              <span className="attachments-total">
                {attachmentTotal.toLocaleString()} B /{" "}
                {ATTACHMENT_BYTE_LIMIT.toLocaleString()} B
              </span>
            </div>
          )}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          {commandOpen && (
            <CommandMenu
              items={commandItems}
              active={activeCommand}
              choose={(command) => {
                void chooseCommand(command);
              }}
              loading={toolsQuery.isLoading}
              error={!!toolsQuery.error}
              retry={() => {
                void toolsQuery.refetch();
              }}
              scope={toolsQuery.data?.scope}
            />
          )}
          <textarea
            ref={textarea}
            aria-label={t("Zpráva", "Message")}
            aria-autocomplete="list"
            aria-controls={commandOpen ? "void-command-list" : undefined}
            aria-expanded={commandOpen}
            aria-activedescendant={
              commandOpen && commandItems.length
                ? `void-command-${activeCommand}`
                : undefined
            }
            aria-describedby={budget ? "composer-budget" : undefined}
            placeholder={t(
              "Napište zprávu nebo / pro příkazy a nástroje",
              "Message or / for commands and tools",
            )}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              if (
                selectedTool &&
                !e.target.value.startsWith(toolPrompt(selectedTool))
              )
                setSelectedTool(undefined);
              setCommandDismissed(false);
              setCommandIndex(0);
            }}
            rows={2}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape" && !commandOpen && running && id) {
                e.preventDefault();
                void stopRun();
                return;
              }
              if (e.key === "ArrowUp" && !draft && !running) {
                const previous = lastUserMessage(rawEvents);
                if (previous) {
                  e.preventDefault();
                  setRetry(false);
                  selectBranch(previous);
                  setEdited(previous.text);
                  return;
                }
              }
              if (commandOpen) {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setCommandDismissed(true);
                  return;
                }
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  setCommandIndex(
                    (activeCommand +
                      (e.key === "ArrowDown" ? 1 : -1) +
                      commandItems.length) %
                      Math.max(1, commandItems.length),
                  );
                  return;
                }
                if (
                  (e.key === "Enter" && !e.shiftKey) ||
                  (e.key === "Tab" && commandItems.length)
                ) {
                  e.preventDefault();
                  if (commandItems[activeCommand])
                    void chooseCommand(commandItems[activeCommand]);
                  return;
                }
              }
              const enter =
                preferences.data?.preferences?.sendBehavior === "enter";
              if (
                e.key === "Enter" &&
                (e.metaKey ||
                  e.ctrlKey ||
                  (enter &&
                    !e.shiftKey &&
                    window.matchMedia("(min-width: 768px)").matches))
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {budget && (
            // No live region: this text recomputes on every keystroke, and a
            // number read back per character is noise. The textarea already
            // points at it with aria-describedby, so it is announced when the
            // user reaches it rather than on every character typed.
            <p
              className="composer-budget"
              id="composer-budget"
              data-over={size.over || undefined}
            >
              {budget}
            </p>
          )}
          <div className="composer-actions">
            <button type="button" className="chat-options-trigger"
              aria-label={t("Nastavení konverzace", "Conversation settings")}
              onClick={() => setChatOptions(true)}><Icon name="more" /></button>
            <button
              type="button"
              className="command-trigger"
              aria-label={t(
                "Otevřít příkazy a nástroje",
                "Open commands and tools",
              )}
              onClick={() => {
                if (!draft) {
                  setDraft("/");
                  setCommandDismissed(false);
                  setCommandIndex(0);
                } else {
                  setCommandDismissed(false);
                }
                textarea.current?.focus();
              }}
              disabled={!!draft && !draft.startsWith("/")}
              title={t("Příkazy a nástroje", "Commands and tools")}
            >
              /
            </button>
            <div>
              <label
                className="attach-button"
                title={t(
                  "Přiložit textový soubor do 24 KB",
                  "Attach a text file up to 24 KB",
                )}
              >
                <Icon name="plus" />
                <span className="sr-only">
                  {t("Přiložit textový soubor", "Attach text file")}
                </span>
                <input
                  type="file"
                  accept=".txt,.md,.csv,.json,.ts,.js,.py,.css,.html,.yaml,.yml"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    if (
                      file.size + attachmentTotal >
                      ATTACHMENT_BYTE_LIMIT
                    ) {
                      setError(
                        t(
                          "Přílohy mohou mít dohromady nejvýše " +
                            Math.round(ATTACHMENT_BYTE_LIMIT / 1024) +
                            " kB.",
                          "Attachments may total at most " +
                            Math.round(ATTACHMENT_BYTE_LIMIT / 1024) +
                            " kB.",
                        ),
                      );
                      return;
                    }
                    setAttachments([
                      ...attachments,
                      {
                        name: file.name,
                        content: await file.text(),
                        bytes: file.size,
                      },
                    ]);
                    e.target.value = "";
                  }}
                />
              </label>
              <button
                type="button"
                disabled={!id}
                onClick={() => setContextPicker(true)}
                aria-label={t(
                  "Přiložit dokument z konverzace",
                  "Attach conversation document",
                )}
              >
                <Icon name="documents" />
              </button>
              <button
                className="model-button"
                type="button"
                disabled={!!id}
                onClick={() => setPicker(true)}
                aria-label={t(
                  "Vybrat model pro novou konverzaci",
                  "Choose a model for a new conversation",
                )}
              >
                {(session?.model || model) ||
                  t("Vybrat model", "Choose a model")}
                <Icon name="chevron" />
              </button>
            </div>
            {running ? (
              <button
                type="button"
                disabled={busy || !runCanStop(session)}
                title={t("Zastavit (Esc)", "Stop (Esc)")}
                aria-label={t("Zastavit běh", "Stop the run")}
                onClick={() => {
                  void stopRun();
                }}
              >
                <Icon name="stop" />
              </button>
            ) : (
              <m.button
                whileTap={animate ? { scale: 0.9 } : undefined}
                className="primary send"
                disabled={
                  busy ||
                  !draft.trim() ||
                  size.over ||
                  (!!id && !session) ||
                  (!id && (providerStatus(provider.data) !== "ready" || !selectedAgent)) ||
                  retryWait > 0
                }
                aria-label={t("Odeslat zprávu", "Send message")}
              >
{busy ? "…" : <Icon name="send" />}
              </m.button>
            )}

          </div>
        </form>

      </div>
      {chatOptions && (
        <Dialog title={t("Nastavení konverzace", "Conversation settings")} close={() => setChatOptions(false)}>
        <div className="composer-footnote">
          <span>{providerLabel}</span>
          <span
            title={t(
              "Vstupní a výstupní tokeny podle posledního hlášení providera",
              "Input and output tokens from the latest provider report",
            )}
          >
            {usage.totalTokens === null
              ? t("Tokeny neznámé", "Tokens unknown")
              : `${usage.totalTokens.toLocaleString()} tokens`}
            {usage.cost === null ? ` · ${t("cena neznámá", "cost unknown")}` : ` · ${usage.cost}`}
          </span>
          <span>
            {(session?.agent ?? preferences.data?.preferences?.defaultAgentPreset) ===
            "prime-agent"
              ? `prime-agent · ${t("Místní PC", "Local PC")}`
              : capabilities.data?.mode === "local"
                ? t("Místní VOID", "VOID Local")
                : t("VOID Cloud", "VOID Cloud")}
          </span>
          <button onClick={() => { setChatOptions(false); onContext(); }}>
            {t("Dokumenty a kontext", "Documents and context")}
          </button>
          <span>
            {t("Důležité výstupy vždy ověřte.", "Verify important results.")}
          </span>
        </div>

          <div className="composer-mode-row">
            <PermissionModeSwitch
              mode={perm.mode}
              source={perm.source}
              onChange={perm.setMode}
            />
            <span className="muted perm-source">
              {perm.source === "server"
                ? t("Zdroj: server", "Source: server")
                : perm.source === "pending"
                  ? t("Režim se ověřuje u serveru", "Checking the server")
                  : t(
                      "Server mode unavailable — read-only fallback",
                      "Server mode unavailable — read-only fallback",
                    )}
            </span>
          </div>
        {!id && <div className="new-session-options">
          <h3>{t("Projekt a agent", "Project and agent")}</h3>
          <ErrorBox error={projects.error ?? agents.error} />
          {capabilities.data?.projects === true ? <label>
            {t("Projekt", "Project")}
            <select value={project} onChange={event => setProject(event.target.value)} disabled={projects.isPending}>
              <option value="">{t("Bez projektu", "No project")}</option>
              {(projects.data?.items ?? []).map((row: Row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </label> : <p className="muted">{t("Projekty nejsou na tomto hostu dostupné.", "Projects are not available on this host.")}</p>}
          <label>{t("Agent pro tuto konverzaci", "Agent for this conversation")}
            <select value={selectedAgent ?? ""} onChange={event => setAgent(event.target.value)} disabled={agents.isPending || agents.data?.supported === false}>
              <option value="" disabled>{t("Vyberte dostupného agenta", "Choose an available agent")}</option>
              {agentOptions(agents.data).map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
          </label>
          <p className="muted">{t("Nastavení se zachytí při vytvoření konverzace. Oprávnění nadále řídí server.", "Settings are captured when the conversation starts. Permissions remain server-controlled.")}</p>
          {capabilities.data?.backgroundQueue === true && <label className="project-background">
            <input type="checkbox" checked={background} onChange={event => setBackground(event.target.checked)} />
            {t("Spustit na pozadí", "Run in background")}
          </label>}
          <button type="button" onClick={() => navigate("/settings")}>{t("Spravovat projekty a agenty", "Manage projects and agents")}</button>
        </div>}
        </Dialog>
      )}
      {contextPicker && (
        <Dialog
          title={t("Přiložit dokument", "Attach document")}
          close={() => setContextPicker(false)}
        >
          <p>
            {t(
              "Do zprávy se přiloží aktuální obsah dokumentu.",
              "The current document content is attached to the message.",
            )}
          </p>
          {Object.entries(workspace.data?.workspace?.files ?? {}).map(
            ([name, value]) => (
              <button
                key={name}
                onClick={() => {
                  const content = String(value);
                  const bytes = new TextEncoder().encode(content).length;
                  if (bytes + attachmentTotal > ATTACHMENT_BYTE_LIMIT) {
                    setError(
                      t(
                        "Kontext přesahuje " +
                          Math.round(ATTACHMENT_BYTE_LIMIT / 1024) +
                          " kB.",
                        "Context exceeds " +
                          Math.round(ATTACHMENT_BYTE_LIMIT / 1024) +
                          " kB.",
                      ),
                    );
                    setContextPicker(false);
                    return;
                  }
                  setAttachments([...attachments, { name, content, bytes }]);
                  setContextPicker(false);
                }}
              >
                {name}
              </button>
            ),
          )}
        </Dialog>
      )}
      {approval && (
        <ApprovalReview
          record={approval}
          close={() => setApproval(undefined)}
        />
      )}
      {picker && (
        <Dialog
          title={t("Vybrat model", "Choose model")}
          close={() => setPicker(false)}
        >
          <input
            autoFocus
            type="search"
            aria-label={t("Hledat model", "Search models")}
            value={modelSearch}
            onChange={(e) => setModelSearch(e.target.value)}
            placeholder={t("Hledat model…", "Search models…")}
          />
          <div className="model-list">
            {catalog
              .filter((m) =>
                (m.name + " " + m.id)
                  .toLowerCase()
                  .includes(modelSearch.toLowerCase()),
              )
              .sort(
                (a, b) =>
                  Number(favorites.includes(b.id)) -
                  Number(favorites.includes(a.id)),
              )
              .map((m) => (
                <div className="model-choice" key={m.id}>
                  <button
                    onClick={() => {
                      setModel(m.id);
                      setPicker(false);
                    }}
                  >
                    <strong>{m.name ?? m.id}</strong>
                    <small>{m.id}</small>
                    {m.id === model && <span>✓</span>}
                  </button>
                  <button
                    aria-label={t("Oblíbený model", "Favorite model")}
                    aria-pressed={favorites.includes(m.id)}
                    onClick={() => {
                      const next = favorites.includes(m.id)
                        ? favorites.filter((f) => f !== m.id)
                        : [...favorites, m.id];
                      setFavorites(next);
                      localStorage.setItem("void-model-favorites", json(next));
                    }}
                  >
                    {favorites.includes(m.id) ? "★" : "☆"}
                  </button>
                </div>
              ))}
          </div>
        </Dialog>
      )}
      {branch && (
        <Dialog
          title={t("Nová větev konverzace", "New conversation branch")}
          close={() => setBranch(undefined)}
        >
          <p>
            {t(
              "Původní historie zůstane zachovaná. Dřívější nástroje se znovu nespustí.",
              "Original history stays intact. Previous tools will not run again.",
            )}
          </p>
          {branch.kind === "user" && (
            <textarea
              aria-label={t("Upravená zpráva", "Edited message")}
              value={edited}
              onChange={(e) => setEdited(e.target.value)}
              rows={6}
            />
          )}
          {retry && (
            <p>
              {t(
                "Nová odpověď může použít nástroje. Zkontrolujte zprávu před spuštěním.",
                "The new response may use tools. Review the message before running.",
              )}
            </p>
          )}
          <ErrorBox error={error} />
          <button
            className="primary"
            disabled={busy || retryWait > 0}
            onClick={fork}
          >
            {retry
              ? t("Vytvořit větev a zkusit znovu", "Create branch and retry")
              : t("Vytvořit větev", "Create branch")}
          </button>
        </Dialog>
      )}
    </section>
  );
}
