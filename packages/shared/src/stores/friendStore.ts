import { create } from 'zustand';
import api from '../services/api.js';
import type { Friendship, FriendRequest } from '../types/index.js';

interface FriendState {
  friends: Friendship[];
  requests: FriendRequest[];
  fetchFriends: () => Promise<void>;
  fetchRequests: () => Promise<void>;
  sendRequest: (userId: string) => Promise<void>;
  acceptRequest: (id: string) => Promise<void>;
  declineRequest: (id: string) => Promise<void>;
  removeFriend: (id: string) => Promise<void>;
  getFriendStatus: (userId: string) => Promise<{ id?: string; status: string; isOutgoing?: boolean }>;

  // Local SignalR handlers
  addRequestLocal: (request: FriendRequest) => void;
  acceptRequestLocal: (friendship: Friendship) => void;
  removeFriendLocal: (friendshipId: string) => void;
}

export const useFriendStore = create<FriendState>((set, get) => ({
  friends: [],
  requests: [],

  fetchFriends: async () => {
    const res = await api.get('/friends');
    set({ friends: res.data });
  },

  fetchRequests: async () => {
    const res = await api.get('/friends/requests');
    set({ requests: res.data });
  },

  sendRequest: async (userId) => {
    await api.post(`/friends/request/${userId}`);
    // Re-fetch to get the new request in our outgoing list
    await get().fetchRequests();
  },

  acceptRequest: async (id) => {
    await api.post(`/friends/accept/${id}`);
    // Move from requests to friends
    const req = get().requests.find((r) => r.id === id);
    set((s) => ({
      requests: s.requests.filter((r) => r.id !== id),
    }));
    if (req) {
      // Re-fetch friends to get the full friendship DTO
      await get().fetchFriends();
    }
  },

  declineRequest: async (id) => {
    await api.post(`/friends/decline/${id}`);
    set((s) => ({
      requests: s.requests.filter((r) => r.id !== id),
    }));
  },

  removeFriend: async (id) => {
    await api.delete(`/friends/${id}`);
    set((s) => ({
      friends: s.friends.filter((f) => f.id !== id),
    }));
  },

  getFriendStatus: async (userId) => {
    const res = await api.get(`/friends/status/${userId}`);
    return res.data;
  },

  addRequestLocal: (request) => {
    set((s) => {
      if (s.requests.some((r) => r.id === request.id)) return s;
      return { requests: [request, ...s.requests] };
    });
  },

  acceptRequestLocal: (friendship) => {
    set((s) => ({
      // Remove the pending request that corresponds to this friendship
      requests: s.requests.filter((r) => r.id !== friendship.id),
      // Add to friends list
      friends: s.friends.some((f) => f.id === friendship.id)
        ? s.friends
        : [friendship, ...s.friends],
    }));
  },

  removeFriendLocal: (friendshipId) => {
    set((s) => ({
      friends: s.friends.filter((f) => f.id !== friendshipId),
    }));
  },
}));
