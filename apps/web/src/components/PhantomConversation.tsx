/// <reference types="chrome" />
/**
 * PhantomConversation — shared conversation UI component.
 *
 * Used by both sidepanel.tsx (full-height, docked) and popup.tsx
 * (600×400px, constrained). The component adapts to available height
 * via the `compact` prop.
 *
 * Authentication state is read from chrome.storage.local via the
 * background service worker message protocol. When unauthenticated,
 * renders a single "Connect" prompt. When authenticated, renders the
 * full streaming conversation UI.
 *
 * Convex integration uses useUIMessages + useSmoothText from
 * @convex-dev/agent/react, preserving the pattern from the original ai.tsx.
 */

import { useUIMessages, useSmoothText, type UIMessage } from "@convex-dev/agent/react";
import { api } from "@phantom-agent-base/backend/convex/_generated/api";
import { useMutation } from "convex/react";
import { Loader2, Send, Wallet, LogOut } from "lucide-react";
import { useRef, useEffect, useState, useCallback } from "react";
import { Streamdown } from "streamdown";

import type { PhantomSession, ExtensionMessage } from "../background";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ConversationProps = {
  /** Render in compact mode for the popup (600×400). Default: false (side panel). */
  compact?: boolean;
};

// ---------------------------------------------------------------------------
// Background service worker communication
// ---------------------------------------------------------------------------

function sendBackgroundMessage(message: ExtensionMessage): Promise<ExtensionMessage> {
  return chrome.runtime.sendMessage(message) as Promise<ExtensionMessage>;
}

// ---------------------------------------------------------------------------
// Smooth streaming text renderer
// ---------------------------------------------------------------------------

function MessageContent({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming: boolean;
}): React.JSX.Element {
  const [visibleText] = useSmoothText(text, { startStreaming: isStreaming });
  return <Streamdown>{visibleText}</Streamdown>;
}

// ---------------------------------------------------------------------------
// Approve / Reject inline action buttons
// ---------------------------------------------------------------------------

/**
 * Renders [Approve] [Reject] buttons when the agent's message contains them.
 * The buttons send the user's decision back as a text message rather than
 * calling the approval mutation directly, so the agent can confirm the
 * outcome in the conversation.
 */
function ApprovalActions({
  onDecision,
}: {
  onDecision: (decision: "approve" | "reject") => void;
}): React.JSX.Element {
  return (
    <div className="flex gap-2 mt-3">
      <button
        type="button"
        onClick={() => onDecision("approve")}
        className="px-4 py-1.5 text-sm font-medium rounded-md bg-green-600 hover:bg-green-500 text-white transition-colors"
      >
        Approve
      </button>
      <button
        type="button"
        onClick={() => onDecision("reject")}
        className="px-4 py-1.5 text-sm font-medium rounded-md bg-red-700 hover:bg-red-600 text-white transition-colors"
      >
        Reject
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect screen — shown when not authenticated
// ---------------------------------------------------------------------------

function ConnectScreen({
  onConnect,
  isConnecting,
  error,
}: {
  onConnect: () => void;
  isConnecting: boolean;
  error: string | null;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 p-8 text-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-14 h-14 rounded-2xl bg-purple-600/20 flex items-center justify-center">
          <Wallet className="w-7 h-7 text-purple-400" />
        </div>
        <h1 className="text-lg font-semibold text-foreground">Phantom Agent</h1>
        <p className="text-sm text-muted-foreground max-w-[240px] leading-relaxed">
          Connect your Phantom wallet to get started with natural language wallet control.
        </p>
      </div>

      {error && (
        <p className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2 max-w-[280px]">
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={onConnect}
        disabled={isConnecting}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm transition-colors"
      >
        {isConnecting ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            Connecting…
          </>
        ) : (
          <>
            <Wallet className="w-4 h-4" />
            Connect Phantom
          </>
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main conversation component
// ---------------------------------------------------------------------------

export function PhantomConversation({ compact = false }: ConversationProps): React.JSX.Element {
  const [session, setSession] = useState<PhantomSession | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const createThread = useMutation(api.chat.createNewThread);
  const sendMessageMutation = useMutation(api.chat.sendMessage);

  // ---------------------------------------------------------------------------
  // Session loading
  // ---------------------------------------------------------------------------

  const loadSession = useCallback(async () => {
    try {
      const response = await sendBackgroundMessage({ type: "GET_SESSION" });
      if (response.type === "SESSION_RESULT") {
        setSession(response.session);
      }
    } catch {
      setSession(null);
    } finally {
      setIsLoadingSession(false);
    }
  }, []);

  useEffect(() => {
    void loadSession();

    // Listen for session changes broadcast from the background service worker
    const handleMessage = (message: ExtensionMessage) => {
      if (message.type === "SESSION_CHANGED") {
        setSession(message.session);
        if (!message.session) {
          // Session cleared — reset conversation state
          setThreadId(null);
        }
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [loadSession]);

  // ---------------------------------------------------------------------------
  // Connect / disconnect
  // ---------------------------------------------------------------------------

  const handleConnect = useCallback(async () => {
    setIsConnecting(true);
    setConnectError(null);
    try {
      const response = await sendBackgroundMessage({ type: "CONNECT" });
      if (response.type === "SESSION_RESULT" && response.session) {
        setSession(response.session);
      } else if (response.type === "ERROR") {
        setConnectError(response.message);
      }
    } catch (err) {
      setConnectError(
        err instanceof Error ? err.message : "Connection failed. Please try again.",
      );
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    await sendBackgroundMessage({ type: "DISCONNECT" });
    setSession(null);
    setThreadId(null);
  }, []);

  // ---------------------------------------------------------------------------
  // Message subscription
  // ---------------------------------------------------------------------------

  const { results: messages } = useUIMessages(
    api.chat.listMessages,
    threadId ? { threadId } : "skip",
    { initialNumItems: 50, stream: true },
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const hasStreamingMessage = messages?.some((m: UIMessage) => m.status === "streaming");

  // ---------------------------------------------------------------------------
  // Send message
  // ---------------------------------------------------------------------------

  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim() || isSending || !session) return;
      setIsSending(true);
      setInput("");

      try {
        let currentThreadId = threadId;
        if (!currentThreadId) {
          currentThreadId = await createThread({ sessionToken: session.stamperPublicKey });
          setThreadId(currentThreadId);
        }
        await sendMessageMutation({
          threadId: currentThreadId,
          prompt: text.trim(),
          sessionToken: session.stamperPublicKey,
          stamperSecretKey: session.stamperSecretKey,
        });
      } catch (err) {
        console.error("Failed to send message:", err);
      } finally {
        setIsSending(false);
      }
    },
    [isSending, session, threadId, createThread, sendMessageMutation],
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void handleSend(input);
    },
    [handleSend, input],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend(input);
      }
    },
    [handleSend, input],
  );

  // Handle approval decision — send as a natural language message
  const handleApprovalDecision = useCallback(
    (decision: "approve" | "reject") => {
      void handleSend(decision === "approve" ? "approve" : "reject");
    },
    [handleSend],
  );

  // ---------------------------------------------------------------------------
  // Render states
  // ---------------------------------------------------------------------------

  if (isLoadingSession) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) {
    return (
      <ConnectScreen
        onConnect={handleConnect}
        isConnecting={isConnecting}
        error={connectError}
      />
    );
  }

  // ---------------------------------------------------------------------------
  // Authenticated conversation view
  // ---------------------------------------------------------------------------

  return (
    <div className={`flex flex-col bg-background text-foreground ${compact ? "h-[600px] w-[400px]" : "h-screen"}`}>
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-purple-600/20 flex items-center justify-center">
            <Wallet className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <span className="text-sm font-medium">Phantom Agent</span>
        </div>
        <button
          type="button"
          onClick={() => void handleDisconnect()}
          className="p-1.5 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          title="Disconnect wallet"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </header>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">
        {(!messages || messages.length === 0) && !hasStreamingMessage && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <p className="text-sm text-muted-foreground">
              What would you like to do with your wallet?
            </p>
            <p className="text-xs text-muted-foreground/60">
              Try "swap 1 SOL to BONK" or "what's my Ethereum address"
            </p>
          </div>
        )}

        {messages?.map((message: UIMessage) => {
          const isAgent = message.role === "assistant";
          const text = message.text ?? "";
          const isStreaming = message.status === "streaming";
          const hasApprovalButtons =
            isAgent && text.includes("[Approve]") && text.includes("[Reject]");

          return (
            <div
              key={message.key}
              className={`flex ${isAgent ? "justify-start" : "justify-end"}`}
            >
              <div
                className={`
                  max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed
                  ${isAgent
                    ? "bg-muted text-foreground rounded-tl-sm"
                    : "bg-purple-600 text-white rounded-tr-sm"
                  }
                `}
              >
                {isAgent ? (
                  <>
                    <MessageContent text={text} isStreaming={isStreaming} />
                    {hasApprovalButtons && !isStreaming && (
                      <ApprovalActions onDecision={handleApprovalDecision} />
                    )}
                  </>
                ) : (
                  <span className="whitespace-pre-wrap">{text}</span>
                )}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-border px-4 py-3">
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message Phantom Agent…"
            rows={1}
            className="
              flex-1 resize-none bg-muted rounded-xl px-3 py-2.5 text-sm
              placeholder:text-muted-foreground/60 outline-none focus:ring-1
              focus:ring-purple-500/60 min-h-[40px] max-h-[120px]
              leading-relaxed transition-shadow
            "
            style={{
              height: "auto",
              minHeight: "40px",
            }}
            onInput={(e) => {
              const target = e.currentTarget;
              target.style.height = "auto";
              target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
            }}
            disabled={isSending}
          />
          <button
            type="submit"
            disabled={!input.trim() || isSending}
            className="
              p-2.5 rounded-xl bg-purple-600 hover:bg-purple-500
              disabled:opacity-40 disabled:cursor-not-allowed
              text-white transition-colors shrink-0
            "
          >
            {isSending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
