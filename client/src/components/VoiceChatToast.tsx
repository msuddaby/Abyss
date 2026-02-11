import { useEffect, useState } from 'react';
import { useVoiceChatStore, useVoiceStore, getApiBase } from '@abyss/shared';

export default function VoiceChatToast() {
  const toastMessage = useVoiceChatStore((s) => s.toastMessage);
  const dismissToast = useVoiceChatStore((s) => s.dismissToast);
  const isVoiceChatOpen = useVoiceStore((s) => s.isVoiceChatOpen);
  const toggleVoiceChat = useVoiceStore((s) => s.toggleVoiceChat);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!toastMessage || isVoiceChatOpen) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(dismissToast, 300); // wait for exit animation
    }, 4000);
    return () => clearTimeout(timer);
  }, [toastMessage, isVoiceChatOpen, dismissToast]);

  if (!toastMessage || isVoiceChatOpen) return null;

  const avatarUrl = toastMessage.author.avatarUrl;
  const avatarSrc = avatarUrl
    ? avatarUrl.startsWith('http') ? avatarUrl : `${getApiBase()}${avatarUrl}`
    : null;

  const handleClick = () => {
    setVisible(false);
    dismissToast();
    if (!isVoiceChatOpen) toggleVoiceChat();
  };

  // Strip custom emoji markup for preview
  const preview = toastMessage.content
    .replace(/<:(\w+):\w+>/g, ':$1:')
    .slice(0, 120) || (toastMessage.attachments.length > 0 ? 'sent an attachment' : '');

  return (
    <div className={`voice-chat-toast${visible ? ' visible' : ''}`} onClick={handleClick}>
      <div className="voice-chat-toast-avatar">
        {avatarSrc ? (
          <img src={avatarSrc} alt="" />
        ) : (
          <div className="voice-chat-toast-avatar-fallback">
            {toastMessage.author.displayName.charAt(0).toUpperCase()}
          </div>
        )}
      </div>
      <div className="voice-chat-toast-body">
        <span className="voice-chat-toast-name">{toastMessage.author.displayName}</span>
        <span className="voice-chat-toast-text">{preview}</span>
      </div>
    </div>
  );
}
