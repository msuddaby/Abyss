import { loadRnnoise, RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletPath from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmPath from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseWasmSimdPath from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

// Cache WASM binary at module level — loaded once, reused across instances
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null;
// Track which AudioContexts have had the worklet module registered
const registeredContexts = new WeakSet<AudioContext>();

function loadWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = loadRnnoise({
      url: rnnoiseWasmPath,
      simdUrl: rnnoiseWasmSimdPath,
    });
  }
  return wasmBinaryPromise;
}

async function registerWorklet(ctx: AudioContext): Promise<void> {
  if (registeredContexts.has(ctx)) return;
  await ctx.audioWorklet.addModule(rnnoiseWorkletPath);
  registeredContexts.add(ctx);
}

export class NoiseSuppressor {
  private source: MediaStreamAudioSourceNode | null = null;
  private highpass: BiquadFilterNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private rnnoise: RnnoiseWorkletNode | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private ctx: AudioContext | null = null;
  private ownsContext = false;

  /**
   * Build the processing chain and return the processed MediaStream.
   * Returns null on failure (caller should fall back to raw stream).
   *
   * RNNoise requires 48kHz — the AudioContext is created at that sample rate.
   * The chain: MediaStreamSource → Highpass(85Hz) → Lowpass(14kHz) → RNNoise → Destination
   */
  async initialize(
    rawStream: MediaStream,
    audioContext: AudioContext,
  ): Promise<MediaStream | null> {
    try {
      // RNNoise requires 48kHz — if the shared context isn't 48kHz, create a dedicated one
      let ctx = audioContext;
      if (ctx.sampleRate !== 48000) {
        ctx = new AudioContext({ sampleRate: 48000 });
        this.ownsContext = true;
        console.log(`[NoiseSuppressor] Created dedicated 48kHz AudioContext (shared was ${audioContext.sampleRate}Hz)`);
      }
      this.ctx = ctx;

      const [wasmBinary] = await Promise.all([
        loadWasmBinary(),
        registerWorklet(ctx),
      ]);

      // Source from the raw mic stream
      this.source = ctx.createMediaStreamSource(rawStream);

      // Highpass at 85Hz — removes rumble, fan hum, plosives
      this.highpass = ctx.createBiquadFilter();
      this.highpass.type = "highpass";
      this.highpass.frequency.value = 85;

      // Lowpass at 14kHz — removes hiss, high-frequency artifacts
      this.lowpass = ctx.createBiquadFilter();
      this.lowpass.type = "lowpass";
      this.lowpass.frequency.value = 14000;

      // RNNoise worklet node
      this.rnnoise = new RnnoiseWorkletNode(ctx, {
        wasmBinary,
        maxChannels: 1,
      });

      // Output destination
      this.destination = ctx.createMediaStreamDestination();

      // Wire: source → highpass → lowpass → rnnoise → destination
      this.source.connect(this.highpass);
      this.highpass.connect(this.lowpass);
      this.lowpass.connect(this.rnnoise);
      this.rnnoise.connect(this.destination);

      console.log("[NoiseSuppressor] Initialized successfully");
      return this.destination.stream;
    } catch (err) {
      console.warn("[NoiseSuppressor] Failed to initialize, falling back to raw stream:", err);
      this.destroy();
      return null;
    }
  }

  /**
   * Swap the input source (e.g. after device switch) without changing the output track.
   * The processed MediaStream identity stays the same, so no sender.replaceTrack() is needed.
   */
  replaceInput(newStream: MediaStream): void {
    if (!this.ctx || !this.highpass) {
      console.warn("[NoiseSuppressor] replaceInput called but not initialized");
      return;
    }

    // Disconnect old source
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }

    // Create new source and wire it
    this.source = this.ctx.createMediaStreamSource(newStream);
    this.source.connect(this.highpass);
    console.log("[NoiseSuppressor] Input replaced");
  }

  /** Get the processed output stream, or null if not initialized. */
  getOutputStream(): MediaStream | null {
    return this.destination?.stream ?? null;
  }

  /** Disconnect all nodes and release resources. */
  destroy(): void {
    try {
      this.source?.disconnect();
      this.highpass?.disconnect();
      this.lowpass?.disconnect();
      if (this.rnnoise) {
        this.rnnoise.disconnect();
        this.rnnoise.destroy();
      }
    } catch {
      // Nodes may already be disconnected
    }
    // Close the dedicated AudioContext if we created one
    if (this.ownsContext && this.ctx && this.ctx.state !== "closed") {
      this.ctx.close().catch(() => {});
    }
    this.source = null;
    this.highpass = null;
    this.lowpass = null;
    this.rnnoise = null;
    this.destination = null;
    this.ctx = null;
    console.log("[NoiseSuppressor] Destroyed");
  }
}
