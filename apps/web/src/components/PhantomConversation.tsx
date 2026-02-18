/// <reference types="chrome" />
/**
 * PhantomConversation — shared conversation UI component.
 */

import { useUIMessages, useSmoothText, type UIMessage } from "@convex-dev/agent/react";
import { api } from "@phantom-agent-base/backend/convex/_generated/api";
import { useMutation } from "convex/react";
import { Loader2, Send, Wallet, LogOut, Bug } from "lucide-react";
import { useRef, useEffect, useState, useCallback } from "react";
import { Streamdown } from "streamdown";

import type { PhantomSession, ExtensionMessage } from "../background";

type ConversationProps = {
  compact?: boolean;
};

function sendBackgroundMessage(message: ExtensionMessage): Promise<ExtensionMessage> {
  return chrome.runtime.sendMessage(message) as Promise<ExtensionMessage>;
}

function MessageContent({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const [visibleText] = useSmoothText(text, { startStreaming: isStreaming });
  return <Streamdown>{visibleText}</Streamdown>;
}

// Debug panel to view background script logs
function DebugPanel({ onClose }: { onClose: () => void }) {
  const [logs, setLogs] = useState<any[]>([]);

  useEffect(() => {
    chrome.storage.local.get("phantom_logs").then((result) => {
      setLogs(result.phantom_logs || []);
    });
  }, []);

  const clearLogs = () => {
    chrome.storage.local.remove("phantom_logs");
    setLogs([]);
  };

  return (
    <div className="fixed inset-0 bg-black/80 z-50 p-4 overflow-auto">
      <div className="bg-background max-w-2xl mx-auto rounded-lg p-4">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-bold">Debug Logs</h2>
          <div className="flex gap-2">
            <button onClick={clearLogs} className="px-3 py-1 bg-red-600 text-white rounded text-sm">
              Clear
            </button>
            <button onClick={onClose} className="px-3 py-1 bg-gray-600 text-white rounded text-sm">
              Close
            </button>
          </div>
        </div>
        <div className="space-y-2 font-mono text-xs">
          {logs.length === 0 && <p className="text-muted-foreground">No logs yet</p>}
          {logs.map((log, i) => (
            <div key={i} className="border-b border-border pb-2">
              <div className="text-muted-foreground">
                {new Date(log.timestamp).toLocaleTimeString()} - {log.context}
              </div>
              <div className="text-foreground break-all">{log.data}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConnectScreen({
  onConnect,
  isConnecting,
  error,
  errorDetails,
  onShowDebug,
}: {
  onConnect: () => void;
  isConnecting: boolean;
  error: string | null;
  errorDetails?: string;
  onShowDebug: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

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
        <div className="w-full max-w-[320px]">
          <div className="text-xs text-destructive bg-destructive/10 rounded-md px-3 py-2">
            <p className="font-semibold mb-1">Error:</p>
            <p>{error}</p>
            {errorDetails && (
              <button
                onClick={() => setShowDetails(!showDetails)}
                className="text-muted-foreground underline mt-2"
              >
                {showDetails ? "Hide details" : "Show details"}
              </button>
            )}
          </div>
          {showDetails && errorDetails && (
            <div className="mt-2 p-2 bg-black/50 rounded text-xs font-mono text-left overflow-auto max-h-[200px]">
              <pre className="whitespace-pre-wrap break-all">{errorDetails}</pre>
            </div>
          )}
        </div>
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

      <button
        onClick={onShowDebug}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <Bug className="w-3 h-3" />
        View Debug Logs
      </button>
    </div>
  );
}

export function PhantomConversation({ compact = false }: ConversationProps): React.JSX.Element {
  const [session, setSession] = useState<PhantomSession | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(true);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [connectErrorDetails, setConnectErrorDetails] = useState<string | undefined>(undefined);
  const [showDebug, setShowDebug] = useState(false);

  const [input, setInput] = useState("");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const createThread = useMutation(api.chat.createNewThread);
  const sendMessageMutation = useMutation(api.chat.sendMessage);

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

    const handleMessage = (message: ExtensionMessage) => {
      if (message.type === "SESSION_CHANGED") {
        setSession(message.session);
        if (!message.session) {
          setThreadId(null);
        }
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [loadSession]);

  const { results: messages } = useUIMessages(
    api.chat.listMessages,
    threadId ? { threadId } : "skip",
    { initialNumItems: 50, stream: true }
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const hasStreamingMessage = messages?.some((m: UIMessage) => m.status === "streaming");

  const handleConnect = useCallback(async () => {
    setIsConnecting(true);
    setConnectError(null);
    setConnectErrorDetails(undefined);
    
    try {
      const response = await sendBackgroundMessage({ type: "CONNECT" });
      
      if (response.type === "ERROR") {
        setConnectError(response.message);
        setConnectErrorDetails(response.details);
      } else if (response.type === "SESSION_RESULT" && response.session) {
        setSession(response.session);
      } else {
        setConnectError("Connection failed - no session returned");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Connection failed";
      const stack = err instanceof Error ? err.stack : undefined;
      setConnectError(message);
      setConnectErrorDetails(stack);
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    await sendBackgroundMessage({ type: "DISCONNECT" });
    setSession(null);
    setThreadId(null);
  }, []);

  const handleSend = useCallback(
    async (text: string) => {
      if (!text.trim() || isSending || !session) return;
      setIsSending(true);
      setInput("");

      try {
        let currentThreadId = threadId;
        if (!currentThreadId) {
          currentThreadId = await createThread({ sessionToken: session.publicKey || session.walletId });
          setThreadId(currentThreadId);
        }
        await sendMessageMutation({
          threadId: currentThreadId,
          prompt: text.trim(),
          sessionToken: session.publicKey || session.walletId,
        });
      } catch (err) {
        console.error("Failed to send message:", err);
      } finally {
        setIsSending(false);
      }
    },
    [isSending, session, threadId, createThread, sendMessageMutation]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      void handleSend(input);
    },
    [handleSend, input]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend(input);
      }
    },
    [handleSend, input]
  );

  if (isLoadingSession) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!session) {
    return (
      <>
        {showDebug && <DebugPanel onClose={() => setShowDebug(false)} />}
        <ConnectScreen
          onConnect={handleConnect}
          isConnecting={isConnecting}
          error={connectError}
          errorDetails={connectErrorDetails}
          onShowDebug={() => setShowDebug(true)}
        />
      </>
    );
  }

  return (
    <div className={`flex flex-col bg-background text-foreground ${compact ? "h-[600px] w-[400px]" : "h-screen"}`}>
      <header className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-purple-600/20 flex items-center justify-center">
            <Wallet className="w-3.5 h-3.5 text-purple-400" />
          </div>
          <span className="text-sm font-medium">Phantom Agent</span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowDebug(true)}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground"
            title="Debug"
          >
            <Bug className="w-4 h-4" />
          </button>
          <button
            onClick={() => void handleDisconnect()}
            className="p-1.5 rounded-md hover:bg-muted text-muted-foreground"
            title="Disconnect"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {showDebug && <DebugPanel onClose={() => setShowDebug(false)} />}

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {(!messages || messages.length === 0) && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center">
            <p className="text-sm text-muted-foreground">What would you like to do with your wallet?</p>
          </div>
        )}

        {messages?.map((message: UIMessage) => (
          <div
            key={message.key}
            className={`flex ${message.role === "assistant" ? "justify-start" : "justify-end"}`}
          >
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                message.role === "assistant"
                  ? "bg-muted text-foreground"
                  : "bg-purple-600 text-white"
              }`}
            >
              {message.role === "assistant" ? (
                <MessageContent text={message.text || ""} isStreaming={message.status === "streaming"} />
              ) : (
                <span>{message.text}</span>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="shrink-0 border-t border-border px-4 py-3">
        <form onSubmit={handleSubmit} className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message..."
            className="flex-1 resize-none bg-muted rounded-xl px-3 py-2.5 text-sm min-h-[40px] max-h-[120px]"
            disabled={isSending}
          />
          <button
            type="submit"
            disabled={!input.trim() || isSending}
            className="p-2.5 rounded-xl bg-purple-600 text-white disabled:opacity-40"
          >
            {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}
