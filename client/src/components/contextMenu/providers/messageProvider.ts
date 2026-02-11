import { useMessageStore, hasPermission, hasChannelPermission, Permission } from '@abyss/shared';
import type { MenuItem, ProviderContext } from '../types';

export function messageProvider(ctx: ProviderContext): MenuItem[] {
  const { entities, actions, currentUser, currentMember, activeChannel, isDmMode } = ctx;
  const { message } = entities;
  if (!message || message.isDeleted || message.isSystem) return [];

  const items: MenuItem[] = [];
  const isOwn = currentUser?.id === message.authorId;
  const canManageMessages = currentMember ? hasPermission(currentMember, Permission.ManageMessages) : false;
  const canDelete = isOwn || canManageMessages;
  const canPin = isDmMode || canManageMessages;
  const canAddReactions = isDmMode ? true : hasChannelPermission(activeChannel?.permissions, Permission.AddReactions);
  const isPinned = useMessageStore.getState().isPinned(message.channelId, message.id);

  items.push({
    id: 'message-reply',
    label: 'Reply',
    group: 'message',
    order: 0,
    action: () => useMessageStore.getState().setReplyingTo(message),
  });

  if (canAddReactions && actions.onOpenReactionPicker) {
    items.push({
      id: 'message-react',
      label: 'Add Reaction',
      group: 'message',
      order: 1,
      action: actions.onOpenReactionPicker,
    });
  }

  if (canPin) {
    items.push({
      id: 'message-pin',
      label: isPinned ? 'Unpin Message' : 'Pin Message',
      group: 'message',
      order: 2,
      action: () => {
        const store = useMessageStore.getState();
        if (isPinned) store.unpinMessage(message.id);
        else store.pinMessage(message.id);
      },
    });
  }

  if (isOwn && actions.onEdit) {
    items.push({
      id: 'message-edit',
      label: 'Edit Message',
      group: 'message',
      order: 3,
      action: actions.onEdit,
    });
  }

  if (canDelete) {
    items.push({
      id: 'message-delete',
      label: 'Delete Message',
      group: 'message',
      order: 4,
      danger: true,
      action: () => useMessageStore.getState().deleteMessage(message.id),
    });
  }

  return items;
}
