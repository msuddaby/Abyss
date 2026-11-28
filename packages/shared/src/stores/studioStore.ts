import { create } from 'zustand';
import api, { postMultipart } from '../services/api.js';
import { getConnection } from '../services/signalr.js';
import { getStorage } from '../storage.js';
import { useAuthStore } from './authStore.js';
import { applyOps, invertOps, studioId } from '../utils/studioOps.js';
import type {
  StudioDoc, StudioOp, StudioOpsBroadcast, StudioAsset, StudioPresence,
  StudioTransport, StudioJoinResult,
} from '../types/studio.js';

// Collaborative editing model:
//   confirmedDoc — the server's doc as of `version` (only server-echoed ops)
//   pending      — local batches sent but not yet echoed back
//   doc          — what the UI renders: confirmedDoc + pending replayed
// Remote batches apply to confirmedDoc, then pending is replayed on top, so
// the local user's in-flight edits never flicker and everyone converges on the
// server's order (last writer wins per field).

interface PendingBatch {
  id: string;
  ops: StudioOp[];
}

const MAX_UNDO = 100;
const PRESENCE_THROTTLE_MS = 80;
const FOLLOW_KEY = 'studio.followTransport';

interface StudioState {
  channelId: string | null;
  loading: boolean;
  error: string | null;
  confirmedDoc: StudioDoc | null;
  doc: StudioDoc | null;
  version: number;
  pending: PendingBatch[];
  canEdit: boolean;
  assets: StudioAsset[];
  /** Users currently in the studio */
  users: string[];
  presence: Record<string, StudioPresence>;
  transport: StudioTransport;
  /** serverTime - localTime, ms */
  serverClockOffset: number;
  followTransport: boolean;
  undoStack: StudioOp[][];
  redoStack: StudioOp[][];
  /** voiceChannelId -> studioChannelId (voice activity links, for the active server) */
  voiceLinks: Record<string, string>;
  /** studioChannelId -> active userIds across the active server (for channel sidebar) */
  channelUsers: Record<string, string[]>;

  join: (channelId: string) => Promise<void>;
  leave: () => void;
  resync: () => Promise<void>;
  /** Apply a local edit optimistically and send it. */
  edit: (ops: StudioOp[], opts?: { undoable?: boolean }) => void;
  undo: () => void;
  redo: () => void;
  uploadAsset: (file: Blob, fileName: string, durationSec: number, onProgress?: (pct: number) => void) => Promise<StudioAsset>;
  /** force: delete even though saved versions use it (server answers 409 otherwise) */
  deleteAsset: (assetId: string, force?: boolean) => Promise<void>;
  resetProject: () => Promise<void>;

  setLocalPresence: (presence: StudioPresence) => void;
  sendTransport: (isPlaying: boolean, positionBeats: number) => void;
  setFollowTransport: (val: boolean) => void;

  // SignalR receivers
  receiveOps: (payload: StudioOpsBroadcast) => void;
  receivePresence: (channelId: string, userId: string, presence: StudioPresence) => void;
  receiveTransport: (channelId: string, transport: StudioTransport) => void;
  receiveUserJoined: (channelId: string, userId: string) => void;
  receiveUserLeft: (channelId: string, userId: string) => void;
  receiveAssetAdded: (channelId: string, asset: StudioAsset) => void;
  receiveAssetRemoved: (channelId: string, assetId: string) => void;
  receiveReset: (channelId: string, doc: StudioDoc, version: number) => void;
  /** Bumped when saved versions change (someone saved, deleted or restored one) */
  versionsTick: number;
  receiveVersionsChanged: (channelId: string) => void;

  setVoiceLinks: (links: Record<string, string>) => void;
  setVoiceLink: (voiceChannelId: string, studioChannelId: string | null) => void;
  setChannelUsers: (usersByChannel: Record<string, string[]>) => void;
  receiveChannelUserJoined: (channelId: string, userId: string) => void;
  receiveChannelUserLeft: (channelId: string, userId: string) => void;
}

const idleTransport: StudioTransport = { isPlaying: false, positionBeats: 0, serverTimeMs: 0, userId: null };

function readFollowPref(): boolean {
  try { return getStorage().getItem(FOLLOW_KEY) !== 'false'; } catch { return true; }
}

let presenceTimer: ReturnType<typeof setTimeout> | null = null;
let queuedPresence: StudioPresence | null = null;

function replay(confirmed: StudioDoc, pending: PendingBatch[]): StudioDoc {
  let doc = confirmed;
  for (const b of pending) doc = applyOps(doc, b.ops);
  return doc;
}

export const useStudioStore = create<StudioState>((set, get) => {
  const send = (batch: PendingBatch) => {
    const { channelId } = get();
    if (!channelId) return;
    getConnection().invoke('StudioApplyOps', channelId, batch.id, batch.ops)
      .catch((e: unknown) => console.warn('[studio] StudioApplyOps failed', e))
      .finally(() => {
        // The echo (if any ops were accepted) arrives before the invoke
        // result. Whatever is still pending for this id was rejected or lost.
        const s = get();
        if (s.channelId !== channelId || !s.pending.some((p) => p.id === batch.id)) return;
        const pending = s.pending.filter((p) => p.id !== batch.id);
        set({ pending, doc: s.confirmedDoc ? replay(s.confirmedDoc, pending) : s.doc });
      });
  };

  const applyLocal = (ops: StudioOp[], stack: 'undo' | 'redo' | 'none', clearRedo: boolean) => {
    const s = get();
    if (!s.doc || !s.canEdit || ops.length === 0) return;
    const inverse = invertOps(s.doc, ops);
    const batch: PendingBatch = { id: studioId(), ops };
    const patch: Partial<StudioState> = {
      pending: [...s.pending, batch],
      doc: applyOps(s.doc, ops),
    };
    if (stack === 'undo') patch.undoStack = [...s.undoStack, inverse].slice(-MAX_UNDO);
    if (stack === 'redo') patch.redoStack = [...s.redoStack, inverse].slice(-MAX_UNDO);
    if (clearRedo) patch.redoStack = [];
    set(patch);
    send(batch);
  };

  return {
    channelId: null,
    loading: false,
    error: null,
    confirmedDoc: null,
    doc: null,
    version: 0,
    pending: [],
    canEdit: false,
    assets: [],
    users: [],
    presence: {},
    transport: idleTransport,
    serverClockOffset: 0,
    followTransport: readFollowPref(),
    undoStack: [],
    redoStack: [],
    voiceLinks: {},
    channelUsers: {},
    versionsTick: 0,

    join: async (channelId) => {
      const prev = get().channelId;
      if (prev && prev !== channelId) get().leave();
      set({ channelId, loading: true, error: null });
      try {
        const sentAt = Date.now();
        const res: StudioJoinResult | null = await getConnection().invoke('JoinStudio', channelId);
        if (get().channelId !== channelId) return;
        if (!res) {
          set({ loading: false, error: 'You do not have access to this studio.' });
          return;
        }
        const rtt = Date.now() - sentAt;
        const unsent = get().pending; // edits made before a resync completed
        set({
          loading: false,
          confirmedDoc: res.doc,
          doc: replay(res.doc, unsent),
          version: res.version,
          canEdit: res.canEdit,
          users: res.users,
          presence: Object.fromEntries(Object.entries(res.presence).filter(([uid]) => uid !== useAuthStore.getState().user?.id)),
          transport: res.transport,
          serverClockOffset: res.serverTimeMs - (sentAt + rtt / 2),
        });
        // LWW sets are idempotent, so re-sending in-flight batches after a
        // reconnect is safe even if the server already applied them.
        for (const b of unsent) send(b);

        const assets = await api.get<StudioAsset[]>(`/channels/${channelId}/studio/assets`);
        if (get().channelId === channelId) set({ assets: assets.data });
      } catch (e) {
        console.error('[studio] join failed', e);
        if (get().channelId === channelId) set({ loading: false, error: 'Failed to open studio.' });
      }
    },

    leave: () => {
      const { channelId } = get();
      if (channelId) {
        getConnection().invoke('LeaveStudio', channelId).catch(() => {});
      }
      if (presenceTimer) { clearTimeout(presenceTimer); presenceTimer = null; }
      queuedPresence = null;
      set({
        channelId: null, confirmedDoc: null, doc: null, version: 0, pending: [], assets: [],
        users: [], presence: {}, transport: idleTransport, undoStack: [], redoStack: [], error: null, loading: false,
      });
    },

    resync: async () => {
      const { channelId } = get();
      if (channelId) await get().join(channelId);
    },

    edit: (ops, opts) => applyLocal(ops, opts?.undoable === false ? 'none' : 'undo', opts?.undoable !== false),

    undo: () => {
      const s = get();
      const ops = s.undoStack[s.undoStack.length - 1];
      if (!ops) return;
      set({ undoStack: s.undoStack.slice(0, -1) });
      applyLocal(ops, 'redo', false);
    },

    redo: () => {
      const s = get();
      const ops = s.redoStack[s.redoStack.length - 1];
      if (!ops) return;
      set({ redoStack: s.redoStack.slice(0, -1) });
      applyLocal(ops, 'undo', false);
    },

    uploadAsset: async (file, fileName, durationSec, onProgress) => {
      const { channelId } = get();
      if (!channelId) throw new Error('No studio open');
      const form = new FormData();
      form.append('file', file, fileName);
      form.append('name', fileName.replace(/\.[^.]+$/, ''));
      form.append('durationSec', String(durationSec));
      const asset = await postMultipart<StudioAsset>(`/channels/${channelId}/studio/assets`, form, { onProgress });
      get().receiveAssetAdded(channelId, asset);
      return asset;
    },

    deleteAsset: async (assetId, force) => {
      const { channelId } = get();
      if (!channelId) return;
      await api.delete(`/channels/${channelId}/studio/assets/${assetId}`, force ? { params: { force: true } } : undefined);
      get().receiveAssetRemoved(channelId, assetId);
    },

    resetProject: async () => {
      const { channelId } = get();
      if (!channelId) return;
      await api.post(`/channels/${channelId}/studio/reset`);
    },

    setLocalPresence: (presence) => {
      const { channelId } = get();
      if (!channelId) return;
      queuedPresence = { ...(queuedPresence ?? {}), ...presence };
      if (presenceTimer) return;
      presenceTimer = setTimeout(() => {
        presenceTimer = null;
        const payload = queuedPresence;
        queuedPresence = null;
        const current = get().channelId;
        if (payload && current) getConnection().invoke('StudioPresence', current, payload).catch(() => {});
      }, PRESENCE_THROTTLE_MS);
    },

    sendTransport: (isPlaying, positionBeats) => {
      const { channelId, serverClockOffset } = get();
      if (!channelId) return;
      set({
        transport: {
          isPlaying, positionBeats,
          serverTimeMs: Date.now() + serverClockOffset,
          userId: useAuthStore.getState().user?.id ?? null,
        },
      });
      getConnection().invoke('StudioTransport', channelId, isPlaying, positionBeats).catch(() => {});
    },

    setFollowTransport: (val) => {
      try { getStorage().setItem(FOLLOW_KEY, String(val)); } catch { /* ignore */ }
      set({ followTransport: val });
    },

    receiveOps: (payload) => {
      const s = get();
      if (payload.channelId !== s.channelId || !s.confirmedDoc) return;
      if (payload.version <= s.version) return; // duplicate / stale
      if (payload.version !== s.version + 1) {
        // Missed a batch (e.g. dropped while reconnecting) — full resync.
        void get().resync();
        return;
      }
      const confirmedDoc = applyOps(s.confirmedDoc, payload.ops);
      const pending = s.pending.filter((p) => p.id !== payload.clientBatchId);
      set({ confirmedDoc, pending, version: payload.version, doc: replay(confirmedDoc, pending) });
    },

    receivePresence: (channelId, userId, presence) => {
      if (channelId !== get().channelId) return;
      set((s) => ({ presence: { ...s.presence, [userId]: { ...s.presence[userId], ...presence } } }));
    },

    receiveTransport: (channelId, transport) => {
      if (channelId !== get().channelId) return;
      set({ transport });
    },

    receiveUserJoined: (channelId, userId) => {
      if (channelId !== get().channelId) return;
      set((s) => ({ users: s.users.includes(userId) ? s.users : [...s.users, userId] }));
    },

    receiveUserLeft: (channelId, userId) => {
      if (channelId !== get().channelId) return;
      set((s) => {
        const presence = { ...s.presence };
        delete presence[userId];
        return { users: s.users.filter((u) => u !== userId), presence };
      });
    },

    receiveAssetAdded: (channelId, asset) => {
      if (channelId !== get().channelId) return;
      set((s) => ({ assets: s.assets.some((a) => a.id === asset.id) ? s.assets : [...s.assets, asset] }));
    },

    receiveAssetRemoved: (channelId, assetId) => {
      if (channelId !== get().channelId) return;
      set((s) => ({ assets: s.assets.filter((a) => a.id !== assetId) }));
    },

    receiveReset: (channelId, doc, version) => {
      if (channelId !== get().channelId) return;
      set({ confirmedDoc: doc, doc, version, pending: [], undoStack: [], redoStack: [] });
    },

    receiveVersionsChanged: (channelId) => {
      if (channelId === get().channelId) set((s) => ({ versionsTick: s.versionsTick + 1 }));
    },

    setVoiceLinks: (links) => set({ voiceLinks: links }),
    setVoiceLink: (voiceChannelId, studioChannelId) => set((s) => {
      const voiceLinks = { ...s.voiceLinks };
      if (studioChannelId) voiceLinks[voiceChannelId] = studioChannelId;
      else delete voiceLinks[voiceChannelId];
      return { voiceLinks };
    }),
    setChannelUsers: (usersByChannel) => set({ channelUsers: usersByChannel }),
    receiveChannelUserJoined: (channelId, userId) => set((s) => {
      const prev = s.channelUsers[channelId] ?? [];
      if (prev.includes(userId)) return s;
      return { channelUsers: { ...s.channelUsers, [channelId]: [...prev, userId] } };
    }),
    receiveChannelUserLeft: (channelId, userId) => set((s) => {
      const prev = s.channelUsers[channelId];
      if (!prev || !prev.includes(userId)) return s;
      const next = prev.filter((u) => u !== userId);
      const channelUsers = { ...s.channelUsers };
      if (next.length) channelUsers[channelId] = next;
      else delete channelUsers[channelId];
      return { channelUsers };
    }),
  };
});
