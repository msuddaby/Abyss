import type { ReactNode } from 'react';
import type { User, ServerMember, Message, Channel, Server } from '@abyss/shared';

export interface ContextEntities {
  user?: User;
  member?: ServerMember;
  message?: Message;
  channel?: Channel;
  server?: Server;
}

export interface ContextActions {
  [key: string]: (...args: any[]) => void;
}

export interface MenuItem {
  id: string;
  label: string;
  group: MenuGroup;
  order: number;
  danger?: boolean;
  action: () => void;
  keepOpen?: boolean;
  render?: () => ReactNode;
}

export type MenuGroup = 'message' | 'user' | 'moderation' | 'voice' | 'channel' | 'server';

export const GROUP_ORDER: MenuGroup[] = ['message', 'user', 'moderation', 'voice', 'channel', 'server'];

export interface ProviderContext {
  entities: ContextEntities;
  actions: ContextActions;
  currentUser: User | null;
  currentMember: ServerMember | undefined;
  activeServer: Server | null;
  activeChannel: Channel | null;
  isDmMode: boolean;
  voiceChannelId: string | null;
  voiceParticipants: Map<string, string>;
  userVolumes: Map<string, number>;
  ttsUsers: Set<string>;
}

export type MenuProvider = (ctx: ProviderContext) => MenuItem[];
