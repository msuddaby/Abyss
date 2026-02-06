import { useState, useRef } from 'react';
import { useMessageStore } from '../stores/messageStore';
import { useServerStore } from '../stores/serverStore';
import { uploadFile } from '../services/api';
import { getConnection } from '../services/signalr';

export default function MessageInput() {
  const [content, setContent] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sendMessage = useMessageStore((s) => s.sendMessage);
  const activeChannel = useServerStore((s) => s.activeChannel);
  const typingTimeout = useRef<ReturnType<typeof setTimeout>>();

  const handleTyping = () => {
    if (!activeChannel) return;
    const conn = getConnection();
    conn.invoke('UserTyping', activeChannel.id).catch(() => {});

    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = setTimeout(() => {}, 3000);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || []);
    setFiles((prev) => [...prev, ...selected]);
    selected.forEach((file) => {
      if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          setPreviews((prev) => [...prev, ev.target?.result as string]);
        };
        reader.readAsDataURL(file);
      }
    });
  };

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
    setPreviews((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!content.trim() && files.length === 0) || !activeChannel || sending) return;

    setSending(true);
    try {
      const attachmentIds: string[] = [];
      for (const file of files) {
        const result = await uploadFile(file);
        attachmentIds.push(result.id);
      }
      await sendMessage(activeChannel.id, content, attachmentIds);
      setContent('');
      setFiles([]);
      setPreviews([]);
    } catch (err) {
      console.error('Failed to send message:', err);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="message-input-container">
      {previews.length > 0 && (
        <div className="file-previews">
          {previews.map((preview, i) => (
            <div key={i} className="file-preview">
              <img src={preview} alt="preview" />
              <button className="remove-file" onClick={() => removeFile(i)}>x</button>
            </div>
          ))}
        </div>
      )}
      <form className="message-input-form" onSubmit={handleSubmit}>
        <button type="button" className="attach-btn" onClick={() => fileInputRef.current?.click()}>
          +
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={handleFileSelect}
        />
        <input
          type="text"
          className="message-input"
          placeholder={activeChannel ? `Message #${activeChannel.name}` : 'Select a channel'}
          value={content}
          onChange={(e) => {
            setContent(e.target.value);
            handleTyping();
          }}
          disabled={!activeChannel}
        />
        <button type="submit" className="send-btn" disabled={sending || (!content.trim() && files.length === 0)}>
          Send
        </button>
      </form>
    </div>
  );
}
