import { useEffect, useRef } from "react";
import { useVoiceStore, useVoiceChatStore, useAuthStore } from "@abyss/shared";
import VoiceChatPanel from "./VoiceChatPanel";
import VoiceChatToast from "./VoiceChatToast";
import { useMobileStore, isMobile } from "../stores/mobileStore";

function cleanContentForTts(content: string): string {
  let text = content;
  text = text.replace(/<:(\w+):\w+>/g, "$1");
  text = text.replace(/https?:\/\/\S+/g, "link");
  text = text.replace(/```[\s\S]*?```/g, "code block");
  text = text.replace(/`[^`]+`/g, "code");
  text = text.replace(/[*_~|>#-]/g, "");
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

export default function VoiceChatOverlay() {
  const currentChannelId = useVoiceStore((s) => s.currentChannelId);
  const isVoiceChatOpen = useVoiceStore((s) => s.isVoiceChatOpen);
  const toggleVoiceChat = useVoiceStore((s) => s.toggleVoiceChat);
  const voiceChatUnread = useVoiceChatStore((s) => s.unreadCount);
  const clearVoiceChatUnread = useVoiceChatStore((s) => s.clearUnread);

  const prevMsgCount = useRef(0);

  useEffect(() => {
    prevMsgCount.current = useVoiceChatStore.getState().messages.length;

    const unsub = useVoiceChatStore.subscribe((state) => {
      if (state.messages.length <= prevMsgCount.current) {
        prevMsgCount.current = state.messages.length;
        return;
      }
      const newMsgs = state.messages.slice(prevMsgCount.current);
      prevMsgCount.current = state.messages.length;

      const myId = useAuthStore.getState().user?.id;
      const ttsUsers = state.ttsUsers;

      for (const msg of newMsgs) {
        if (msg.authorId === myId) continue;
        if (msg.isSystem || msg.isDeleted) continue;
        if (!ttsUsers.has(msg.authorId)) continue;

        const text = cleanContentForTts(msg.content);
        if (!text) continue;

        const utterance = new SpeechSynthesisUtterance(
          `${msg.author.displayName} says: ${text}`,
        );
        speechSynthesis.speak(utterance);
      }
    });

    return () => {
      unsub();
      speechSynthesis.cancel();
    };
  }, []);

  if (!currentChannelId) return null;

  const handleToggle = () => {
    if (!isVoiceChatOpen) {
      clearVoiceChatUnread();
      if (isMobile()) useMobileStore.getState().closeDrawers();
    }
    toggleVoiceChat();
  };

  return (
    <>
      <button
        className={`voice-chat-fab${isVoiceChatOpen ? " active" : ""}`}
        onClick={handleToggle}
        title="Voice chat"
      >
        💬
        {voiceChatUnread > 0 && !isVoiceChatOpen && (
          <span className="voice-chat-unread-badge">
            {voiceChatUnread > 99 ? "99+" : voiceChatUnread}
          </span>
        )}
      </button>
      {isVoiceChatOpen && (
        <div className="voice-chat-floating-panel">
          <VoiceChatPanel />
        </div>
      )}
      <VoiceChatToast />
    </>
  );
}
