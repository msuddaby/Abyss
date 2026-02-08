import { create } from 'zustand';

export type SignalRStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

interface SignalRState {
  status: SignalRStatus;
  lastError: string | null;
  setStatus: (status: SignalRStatus, lastError?: string | null) => void;
}

export const useSignalRStore = create<SignalRState>((set) => ({
  status: 'disconnected',
  lastError: null,
  setStatus: (status, lastError = null) => set({ status, lastError }),
}));
