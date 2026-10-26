import { ChatKit, useChatKit } from "@openai/chatkit-react";
import type { UseChatKitOptions } from "@openai/chatkit-react";
import { useEffect, useRef } from "react";
import { loadPrintableThread, postChatkit, printHtmlDocument, renderPrintDocument } from "./print";

export type HtmlInvocation = { params: { html: string } };
export type MapInvocation = { params: { geojson: string } };

export type AssistantPanelProps = {
  apiUrl: string;
  domainKey: string;
  theme: "light" | "dark";
  onShowMap?: (invocation: MapInvocation) => void;
  onShowHtml: (invocation: HtmlInvocation) => void;
  onClearPanel: () => void;
  chatTheme?: UseChatKitOptions["theme"];
};

type ThreadItem = {
  type: string;
  name?: string;
  status?: string;
  arguments?: { html_url?: string };
};

// Reconstructs the map/HTML panel when switching to a past (e.g. archived)
// thread. show_html client tool calls don't leave a visible thread item of
// their own, so nothing repopulates the panel by default when you reopen an
// old conversation -- this fetches the thread's items directly (the same
// threads.get_by_id op the widget itself uses to load history) and re-shows
// the last completed show_html call's HTML.
async function findLastShowHtml(apiUrl: string, threadId: string): Promise<string | null> {
  const res = await fetch(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "threads.get_by_id",
      params: { thread_id: threadId },
    }),
  });
  if (!res.ok) {
    throw new Error(`threads.get_by_id failed: ${res.status}`);
  }
  const thread = await res.json();
  const items: ThreadItem[] = thread?.items?.data ?? [];
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (
      item.type === "client_tool_call" &&
      item.name === "show_html" &&
      item.status === "completed" &&
      item.arguments?.html_url
    ) {
      return item.arguments.html_url;
    }
  }
  return null;
}


export function AssistantPanel({
  apiUrl,
  domainKey,
  chatTheme,
  theme,
  onShowMap,
  onShowHtml,
  onClearPanel,
}: AssistantPanelProps) {
  // Guards against a fast thread switch resolving out of order and
  // clobbering the panel with a stale response.
  const latestThreadRef = useRef<string | null>(null);
  const printingRef = useRef(false);

  const printConversation = async () => {
    const threadId = latestThreadRef.current;
    if (!threadId) {
      window.alert("Open a conversation before printing.");
      return;
    }
    if (printingRef.current) return;
    printingRef.current = true;
    try {
      const printable = await loadPrintableThread(threadId, postChatkit(apiUrl));
      if (printable.blocks.length === 0) {
        window.alert("This conversation has nothing to print yet.");
        return;
      }
      await printHtmlDocument(
        renderPrintDocument({
          title: printable.title,
          printedAt: new Date(),
          blocks: printable.blocks,
        }),
      );
    } catch (error) {
      console.error(error);
      window.alert("Couldn't load this conversation to print.");
    } finally {
      printingRef.current = false;
    }
  };

  const chatkit = useChatKit({
    api: {
      url: apiUrl,
      domainKey: domainKey,
      uploadStrategy: { type: "two_phase" },
    },
    // ChatKit's header icons have no printer. share is the export control.
    header: {
      rightAction: {
        icon: "share",
        onClick: () => {
          void printConversation();
        },
      },
    },
    composer: {
      // Keep in sync with ALLOWED_MIME_TYPES / MAX_ATTACHMENT_BYTES in
      // backend/app/attachments.py.
      attachments: {
        enabled: true,
        maxSize: 20 * 1024 * 1024,
        maxCount: 5,
        accept: {
          "image/png": [".png"],
          "image/jpeg": [".jpg", ".jpeg"],
          "image/gif": [".gif"],
          "image/webp": [".webp"],
          "application/pdf": [".pdf"],
          "text/csv": [".csv"],
          "text/plain": [".txt"],
          "application/json": [".json"],
          "application/msword": [".doc"],
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
            [".docx"],
          "application/rtf": [".rtf"],
          "application/vnd.oasis.opendocument.text": [".odt"],
          "application/vnd.openxmlformats-officedocument.presentationml.presentation":
            [".pptx"],
          "application/vnd.ms-excel": [".xls"],
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
            [".xlsx"],
        },
      },
    },
    theme: chatTheme ?? {
      colorScheme: theme,
      color: {
        grayscale: {
          hue: 220,
          tint: 6,
          shade: theme === "dark" ? -1 : -4,
        },
        accent: {
          primary: theme === "dark" ? "#f1f5f9" : "#0f172a",
          level: 1,
        },
      },
      radius: "round",
    },
    threadItemActions: {
      feedback: false,
    },
    onClientTool: async (invocation) => {
      if (invocation.name === "show_map") {
        if (!onShowMap || typeof invocation.params.geojson !== "string") return { success: false };
        await onShowMap({ params: { geojson: invocation.params.geojson } });
        return { success: true };
      } else if (invocation.name === "show_html") {
        if (typeof invocation.params.html !== "string") return { success: false };
        await onShowHtml({ params: { html: invocation.params.html } });
        const screenshotUrl = invocation.params?.screenshot_url as
          | string
          | undefined;
        if (!screenshotUrl) {
          return { success: true };
        }
        // Warm the screenshot before answering the tool call. GET /chatkit/{png}
        // awaits the pending server-side screenshot task, so a 200 here means
        // the image is ready for the model to fetch. The value returned from
        // this callback is POSTed back as threads.add_client_tool_output, which
        // re-enters the server's respond() with the screenshot in hand. Only
        // hand back the URL if it actually resolved, so the model is never fed
        // a dead image link.
        let screenshotReady = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          try {
            const res = await fetch(screenshotUrl, { cache: "no-store" });
            if (res.ok) {
              screenshotReady = true;
              break;
            }
          } catch (e) {
            console.warn("screenshot not ready, retrying", e);
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        return screenshotReady
          ? { success: true, screenshot_url: screenshotUrl }
          : { success: true };
      }
      return { success: false };
    },
    onThreadChange: (event: { threadId: string | null }) => {
      const threadId = event.threadId;
      latestThreadRef.current = threadId;
      if (!threadId) {
        onClearPanel();
        return;
      }
      findLastShowHtml(apiUrl, threadId)
        .then((htmlUrl) => {
          if (latestThreadRef.current !== threadId) return; // stale
          if (!htmlUrl) {
            onClearPanel();
            return;
          }
          return fetch(htmlUrl)
            .then((res) => (res.ok ? res.text() : null))
            .then((html) => {
              if (latestThreadRef.current !== threadId) return; // stale
              if (html) {
                onShowHtml({ params: { html } });
              } else {
                onClearPanel();
              }
            });
        })
        .catch((e) => {
          console.warn("Failed to restore panel for thread", threadId, e);
        });
    },
  });
  useEffect(() => {
    let disposed = false;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === "html-error") {
        const text = event.data.message
        const trySend = async (attempt = 0) => {
          if (disposed) return;
          try {
            await chatkit.sendUserMessage({text})
          } catch (e) {
            console.error(e)
            if (attempt < 9 && !disposed) {
              const timer = setTimeout(() => { timers.delete(timer); void trySend(attempt + 1); }, 500);
              timers.add(timer);
            }
          }
        }
        if (typeof text === "string" && text.trim()) {
          trySend().then()
        } else {
          console.warn('ignoring', event.data)
        }
      }
    };
    window.addEventListener("message", handleMessage);
    return () => {
      disposed = true;
      timers.forEach(clearTimeout);
      window.removeEventListener("message", handleMessage);
    };
  }, [chatkit]);

  return (
    <div style={{ position: "relative", height: "100%", width: "100%", overflow: "hidden" }}>
      <ChatKit control={chatkit.control} style={{ display: "block", height: "100%", width: "100%" }} />
    </div>
  );
}
