import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Plus, Send, Paperclip, Mic, Square, Sparkles, AlertTriangle, Bot, X, FileText } from "lucide-react";
import { api } from "../lib/api.js";
import ToolActivity from "../components/ToolActivity.jsx";

const SUGGESTED = ["Draft a launch plan for a new product", "Summarize the key risks in a project", "Brainstorm names for an AI agent"];

function TraceRail({ trace }) {
  if (!trace?.length) return null;
  return <ToolActivity steps={trace} />;
}

function isDeleteAction(toolName) {
  return toolName === "delete_memory" || toolName === "delete_saved_research";
}

const META_ACTION_TOOLS = new Set(["create_campaign", "update_campaign", "pause_campaign", "resume_campaign"]);

function ConfirmationCard({ confirmation, onResolve }) {
  const [busy, setBusy] = useState(false);
  if (!confirmation) return null;

  // Already resolved (either in this session or from a previous page load,
  // persisted server-side) — show what happened instead of stale buttons.
  if (confirmation.resolution) {
    const label =
      confirmation.resolution === "approved" ? "Approved" :
      confirmation.resolution === "rejected" ? "Rejected" : "Could not be resolved";
    return (
      <div className="mt-2 rounded-xl border border-line bg-elevated px-3 py-2 text-xs text-muted">{label}.</div>
    );
  }

  const resolve = async (approved) => {
    setBusy(true);
    try {
      const path = `/confirmations/${confirmation.confirmationId}/${approved ? "approve" : "reject"}`;
      const outcome = await api.post(path, {});
      onResolve(outcome, approved);
    } catch (err) {
      // A 409/410 here means someone (possibly this same user, on an earlier
      // load) already resolved it — treat that as resolved, not as a fresh error.
      const alreadyHandled = err.status === 409 || err.status === 410;
      onResolve(alreadyHandled ? { status: "completed", alreadyHandled: true } : { error: err.message }, approved);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3">
      <p className="text-sm text-amber-600 dark:text-amber-400">Waiting for your approval to continue.</p>
      <div className="mt-2 flex gap-2">
        <button
          disabled={busy}
          onClick={() => resolve(true)}
          className="rounded-lg accent-gradient px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          {isDeleteAction(confirmation.toolName) ? "Delete" : "Approve"}
        </button>
        <button
          disabled={busy}
          onClick={() => resolve(false)}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-muted hover:text-ink disabled:opacity-50"
        >
          {isDeleteAction(confirmation.toolName) ? "Cancel" : META_ACTION_TOOLS.has(confirmation.toolName) ? "Cancel" : "Reject"}
        </button>
      </div>
    </div>
  );
}

export default function Chat() {
  const location = useLocation();
  const [conversations, setConversations] = useState([]);
  const [agents, setAgents] = useState([]);
  const [agentId, setAgentId] = useState("");
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [providerErr, setProviderErr] = useState(null);
  const [attachment, setAttachment] = useState(null); // { title, extractedText, note }
  const [attachUploading, setAttachUploading] = useState(false);
  const [attachError, setAttachError] = useState(null);
  const scrollRef = useRef(null);
  const fileInputRef = useRef(null);

  const loadConversations = () => api.get("/chat/conversations").then(setConversations).catch(() => {});

  useEffect(() => {
    loadConversations();
    api.get("/agents").then((list) => {
      setAgents(list);
      // Default to the user's first agent (so tools are available out of the
      // box) rather than silently landing on the no-agent/no-tools option.
      if (list.length && !agentId) setAgentId(list[0].id);
    }).catch(() => {});
    if (location.state?.prompt) send(location.state.prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight); }, [messages, sending]);

  const openConversation = async (id) => {
    setActiveId(id);
    const d = await api.get(`/chat/conversations/${id}/messages`);
    setMessages(d.messages.map((m) => ({ ...m, ...(m.meta || {}) })));
  };

  const newConversation = () => { setActiveId(null); setMessages([]); setProviderErr(null); setAttachment(null); };

  const onPickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAttachError(null);
    setAttachUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await api.upload("/research/knowledge/upload", formData);
      setAttachment({ title: result.title, extractedText: result.extractedText || "", note: result.note });
    } catch (err) {
      setAttachError(err.message || "Upload failed.");
    } finally {
      setAttachUploading(false);
    }
  };

  const send = async (text) => {
    const content = (text ?? input).trim();
    const hasAttachment = Boolean(attachment);
    if ((!content && !hasAttachment) || sending) return;
    setInput("");
    setProviderErr(null);
    const displayContent = hasAttachment ? `📎 ${attachment.title}${content ? `\n\n${content}` : ""}` : content;
    setMessages((m) => [...m, { id: "tmp-" + Date.now(), role: "user", content: displayContent }]);
    setSending(true);
    const attachmentPayload = hasAttachment ? { attachmentTitle: attachment.title, attachmentText: attachment.extractedText } : {};
    setAttachment(null);
    try {
      const d = await api.post("/chat/message", { conversationId: activeId, content, agentId: agentId || undefined, ...attachmentPayload });
      setActiveId(d.conversationId);
      setMessages((m) => [
        ...m,
        { id: d.assistantMessageId || ("a-" + Date.now()), role: "assistant", content: d.reply, trace: d.trace, toolResults: d.toolResults, confirmation: d.confirmation },
      ]);
      loadConversations();
    } catch (err) {
      if (err.status === 503) setProviderErr(err.detail || "AI provider not configured");
      else setProviderErr(err.message);
      if (err.data?.conversationId) setActiveId(err.data.conversationId);
    } finally {
      setSending(false);
    }
  };

  const resolveConfirmation = (messageId) => (outcome, approved) => {
    const resolution = outcome.error ? "error" : approved ? "approved" : "rejected";
    // Persist into the stored message — without this, reloading the page
    // re-reads the original "pending" snapshot and shows stale buttons again.
    api.patch(`/chat/messages/${messageId}/confirmation`, { resolution }).catch(() => {});

    setMessages((m) =>
      m.map((msg) =>
        msg.id === messageId
          ? {
              ...msg,
              confirmation: msg.confirmation ? { ...msg.confirmation, resolution } : null,
              content: outcome.alreadyHandled
                ? msg.content // already had its outcome appended on the original resolve — don't duplicate it
                : outcome.error
                ? `${msg.content}\n\n(Could not resolve: ${outcome.error})`
                : approved
                ? `${msg.content}\n\n${outcome.status === "completed" ? "Done — approved and completed." : `Not completed: ${outcome.error}`}`
                : `${msg.content}\n\nOkay, I won't do that.`,
            }
          : msg
      )
    );
  };

  return (
    <div className="flex h-[calc(100vh-8.5rem)] gap-4 md:h-[calc(100vh-9rem)]">
      {/* History */}
      <div className="hidden w-60 shrink-0 flex-col rounded-2xl border border-line bg-surface p-3 lg:flex">
        <button onClick={newConversation} className="mb-3 flex items-center gap-2 rounded-xl accent-gradient px-3 py-2.5 text-sm font-medium text-white">
          <Plus size={16} /> New conversation
        </button>

        <label className="mb-3 block">
          <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted"><Bot size={14} /> Agent</span>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="w-full rounded-lg border border-line bg-bg px-2.5 py-2 text-sm outline-none focus:border-accent"
          >
            <option value="">Plain chat (no agent, no tools)</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </label>

        <div className="flex-1 space-y-1 overflow-y-auto">
          {conversations.length === 0 && <p className="px-2 py-3 text-xs text-muted">No conversations yet.</p>}
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => openConversation(c.id)}
              className={`w-full truncate rounded-lg px-3 py-2 text-left text-sm ${activeId === c.id ? "bg-accent/10 text-accent" : "text-muted hover:bg-elevated hover:text-ink"}`}
            >
              {c.title}
            </button>
          ))}
        </div>
      </div>

      {/* Thread */}
      <div className="flex min-w-0 flex-1 flex-col rounded-2xl border border-line bg-surface">
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:p-6">
          {messages.length === 0 && !sending ? (
            <div className="flex h-full flex-col items-center justify-center text-center">
              <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl accent-gradient text-white shadow-glow"><Sparkles size={26} /></div>
              <h2 className="font-display text-xl font-semibold">Your AI workspace starts here.</h2>
              <p className="mt-2 max-w-sm text-sm text-muted">Ask questions, create plans, analyze information, and get things done.</p>
              {agentId ? (
                <p className="mt-2 text-xs text-muted">Try: "Create a task called Launch skincare campaign" or "Remember that I sell skincare products."</p>
              ) : null}
              <div className="mt-6 flex flex-col gap-2">
                {SUGGESTED.map((s) => (
                  <button key={s} onClick={() => send(s)} className="rounded-xl border border-line px-4 py-2.5 text-sm text-muted hover:border-accent/40 hover:text-ink">{s}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-5">
              {messages.map((m) => (
                <div key={m.id} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[85%] ${m.role === "user" ? "" : "w-full"}`}>
                    <div className={`whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm ${m.role === "user" ? "accent-gradient text-white" : "border border-line bg-elevated text-ink"}`}>
                      {m.content}
                    </div>
                    {m.role === "assistant" && <TraceRail trace={m.trace} />}
                    {m.role === "assistant" && m.confirmation && (
                      <ConfirmationCard confirmation={m.confirmation} onResolve={resolveConfirmation(m.id)} />
                    )}
                  </div>
                </div>
              ))}
              {sending && (
                <div className="flex justify-start">
                  <div className="rounded-2xl border border-line bg-elevated px-4 py-3">
                    <span className="flex gap-1">
                      <span className="h-2 w-2 animate-bounce rounded-full bg-muted [animation-delay:-0.2s]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-muted [animation-delay:-0.1s]" />
                      <span className="h-2 w-2 animate-bounce rounded-full bg-muted" />
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {providerErr && (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-500">
            <AlertTriangle size={16} /> AI provider not configured — {providerErr}
          </div>
        )}

        {/* Composer */}
        <div className="border-t border-line p-3">
          {(attachment || attachUploading || attachError) && (
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-line bg-bg px-3 py-2 text-sm">
              <FileText size={14} className="shrink-0 text-accent" />
              {attachUploading ? (
                <span className="text-muted">Uploading…</span>
              ) : attachError ? (
                <>
                  <span className="flex-1 truncate text-red-500">{attachError}</span>
                  <button onClick={() => setAttachError(null)} className="shrink-0 rounded p-0.5 text-muted hover:text-ink"><X size={14} /></button>
                </>
              ) : (
                <>
                  <span className="flex-1 truncate">{attachment.title}</span>
                  {attachment.note && <span className="shrink-0 text-xs text-amber-500">not searchable</span>}
                  <button onClick={() => setAttachment(null)} className="shrink-0 rounded p-0.5 text-muted hover:text-ink"><X size={14} /></button>
                </>
              )}
            </div>
          )}
          <div className="flex items-end gap-2 rounded-2xl border border-line bg-bg px-3 py-2">
            <input ref={fileInputRef} type="file" className="hidden" onChange={onPickFile} />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={attachUploading}
              className="rounded-lg p-2 text-muted hover:bg-elevated disabled:opacity-40"
              title="Attach a file"
            >
              <Paperclip size={18} />
            </button>
            <button className="rounded-lg p-2 text-muted hover:bg-elevated" title="Voice input (coming soon)" disabled><Mic size={18} /></button>
            <textarea
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={attachment ? "Ask something about this file (optional)…" : "Message your assistant…"}
              className="max-h-32 flex-1 resize-none bg-transparent py-2 text-sm outline-none"
            />
            {sending ? (
              <button className="rounded-xl bg-elevated p-2.5 text-muted" title="Stop"><Square size={16} /></button>
            ) : (
              <button onClick={() => send()} disabled={!input.trim() && !attachment} className="rounded-xl accent-gradient p-2.5 text-white disabled:opacity-40"><Send size={16} /></button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
