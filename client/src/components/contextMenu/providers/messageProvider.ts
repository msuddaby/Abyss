import { useMessageStore, useArchiveStore, useToastStore, hasPermission, hasChannelPermission, Permission } from '@abyss/shared';
import { useForumTopicStore } from '../../../stores/forumTopicStore';
import { useReactionDetailsStore } from '../../../stores/reactionDetailsStore';
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

  const liveSplats = (message.splats ?? []).filter((sp) => !sp.wipedAt);
  if (canAddReactions && actions.onThrowTomato && !liveSplats.some((sp) => sp.userId === currentUser?.id)) {
    items.push({
      id: 'message-throw-tomato',
      label: 'Throw Tomato',
      group: 'message',
      order: 1.5,
      action: actions.onThrowTomato,
    });
  }

  if (liveSplats.length > 0 && (isOwn || canManageMessages) && actions.onWipeTomatoes) {
    items.push({
      id: 'message-wipe-tomatoes',
      label: 'Wipe Off Tomatoes',
      group: 'message',
      order: 1.6,
      action: actions.onWipeTomatoes,
    });
  }

  if ((message.reactions?.length ?? 0) > 0) {
    items.push({
      id: 'message-show-reactions',
      label: 'Show Reactions',
      group: 'message',
      order: 2,
      action: () => useReactionDetailsStore.getState().open(message.id, message.channelId),
    });
  }

  if (canPin) {
    items.push({
      id: 'message-pin',
      label: isPinned ? 'Unpin Message' : 'Pin Message',
      group: 'message',
      order: 3,
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
      order: 4,
      action: actions.onEdit,
    });
  }

  if (canDelete) {
    items.push({
      id: 'message-delete',
      label: 'Delete Message',
      group: 'message',
      order: 5,
      danger: true,
      action: () => useMessageStore.getState().deleteMessage(message.id),
    });
  }

  // Save image/video attachments into the server archive
  const media = (message.attachments ?? []).filter((a) => a.contentType.startsWith('image/') || a.contentType.startsWith('video/'));
  const serverId = ctx.activeServer?.id;
  if (!isDmMode && serverId && media.length > 0 && currentMember && hasPermission(currentMember, Permission.UploadToArchive)) {
    items.push({
      id: 'message-save-archive',
      label: media.length > 1 ? `Save ${media.length} Files to Archive` : 'Save to Archive',
      group: 'message',
      order: 4.5,
      action: async () => {
        const results = await Promise.allSettled(media.map((a) => useArchiveStore.getState().saveFromAttachment(serverId, a.id)));
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (ok > 0) useToastStore.getState().addToast(ok > 1 ? `Saved ${ok} files to Archive` : 'Saved to Archive', 'success');
        if (failed) {
          const data = failed.reason?.response?.data;
          useToastStore.getState().addToast(typeof data === 'string' && data ? data : 'Could not save to archive', 'error');
        }
      },
    });
  }

  // Forum topic creation (server channels only, permission-gated)
  const canCreateForumTopic = !isDmMode
    && currentMember
    && hasChannelPermission(activeChannel?.permissions, Permission.CreateForumTopic);
  if (canCreateForumTopic) {
    const ftState = useForumTopicStore.getState();
    const start = ftState.startMessage;
    const sameChannel = start && start.channelId === message.channelId;

    if (!start) {
      items.push({
        id: 'message-forum-start',
        label: 'Start Forum Topic Here',
        group: 'message',
        order: 6,
        action: () => useForumTopicStore.getState().setStart(message),
      });
    } else if (sameChannel && start.id !== message.id) {
      const [first, second] = new Date(start.createdAt) <= new Date(message.createdAt)
        ? [start, message]
        : [message, start];
      items.push({
        id: 'message-forum-end',
        label: 'Create Forum Topic to Here…',
        group: 'message',
        order: 6,
        action: () => useForumTopicStore.getState().openModal(first, second),
      });
      items.push({
        id: 'message-forum-cancel',
        label: 'Cancel Forum Topic Selection',
        group: 'message',
        order: 7,
        action: () => useForumTopicStore.getState().clearStart(),
      });
    } else if (sameChannel && start.id === message.id) {
      items.push({
        id: 'message-forum-cancel',
        label: 'Cancel Forum Topic Selection',
        group: 'message',
        order: 6,
        action: () => useForumTopicStore.getState().clearStart(),
      });
    }
  }

  return items;
}
