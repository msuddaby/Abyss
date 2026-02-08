import { useState, useRef, useEffect } from "react";
import { useAuthStore, useVoiceStore, getApiBase } from "@abyss/shared";

export default function UserSettingsModal({
  onClose,
}: {
  onClose: () => void;
}) {
  const user = useAuthStore((s) => s.user)!;
  const updateProfile = useAuthStore((s) => s.updateProfile);
  const updateAvatar = useAuthStore((s) => s.updateAvatar);
  const logout = useAuthStore((s) => s.logout);

  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio || "");
  const [status, setStatus] = useState(user.status);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [capturingKey, setCapturingKey] = useState(false);
  const [micTestActive, setMicTestActive] = useState(false);
  const [micTestLevel, setMicTestLevel] = useState(0);
  const [micTestRecording, setMicTestRecording] = useState(false);
  const [micTestPlaybackUrl, setMicTestPlaybackUrl] = useState<string | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const micTestStreamRef = useRef<MediaStream | null>(null);
  const micTestCtxRef = useRef<AudioContext | null>(null);
  const micTestAnalyserRef = useRef<AnalyserNode | null>(null);
  const micTestSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micTestRafRef = useRef<number | null>(null);
  const micTestRecorderRef = useRef<MediaRecorder | null>(null);

  const voiceMode = useVoiceStore((s) => s.voiceMode);
  const pttKey = useVoiceStore((s) => s.pttKey);
  const setVoiceMode = useVoiceStore((s) => s.setVoiceMode);
  const setPttKey = useVoiceStore((s) => s.setPttKey);
  const inputDeviceId = useVoiceStore((s) => s.inputDeviceId);
  const outputDeviceId = useVoiceStore((s) => s.outputDeviceId);
  const setInputDeviceId = useVoiceStore((s) => s.setInputDeviceId);
  const setOutputDeviceId = useVoiceStore((s) => s.setOutputDeviceId);
  const noiseSuppression = useVoiceStore((s) => s.noiseSuppression);
  const echoCancellation = useVoiceStore((s) => s.echoCancellation);
  const autoGainControl = useVoiceStore((s) => s.autoGainControl);
  const setNoiseSuppression = useVoiceStore((s) => s.setNoiseSuppression);
  const setEchoCancellation = useVoiceStore((s) => s.setEchoCancellation);
  const setAutoGainControl = useVoiceStore((s) => s.setAutoGainControl);
  const inputSensitivity = useVoiceStore((s) => s.inputSensitivity);
  const setInputSensitivity = useVoiceStore((s) => s.setInputSensitivity);

  const [inputDevices, setInputDevices] = useState<MediaDeviceInfo[]>([]);
  const [outputDevices, setOutputDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const canSelectOutput =
    typeof (
      HTMLMediaElement.prototype as HTMLMediaElement & {
        setSinkId?: (id: string) => Promise<void>;
      }
    ).setSinkId === "function";

  useEffect(() => {
    if (!capturingKey) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      setPttKey(e.key);
      setCapturingKey(false);
    };
    const onMouse = (e: MouseEvent) => {
      // Only capture non-primary buttons (skip left click = 0, right click = 2)
      if (e.button === 0 || e.button === 2) return;
      e.preventDefault();
      setPttKey(`Mouse${e.button}`);
      setCapturingKey(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onMouse);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouse);
    };
  }, [capturingKey, setPttKey]);

  useEffect(() => {
    if (!micTestActive) return;
    if (!navigator.mediaDevices?.getUserMedia) return;

    let cancelled = false;
    const startTest = async () => {
      if (micTestRafRef.current) cancelAnimationFrame(micTestRafRef.current);
      micTestRafRef.current = null;
      if (micTestSourceRef.current) micTestSourceRef.current.disconnect();
      micTestSourceRef.current = null;
      if (micTestCtxRef.current && micTestCtxRef.current.state !== "closed")
        micTestCtxRef.current.close();
      micTestCtxRef.current = null;
      if (micTestStreamRef.current)
        micTestStreamRef.current.getTracks().forEach((track) => track.stop());
      micTestStreamRef.current = null;
      micTestAnalyserRef.current = null;
      setMicTestLevel(0);

      try {
        const constraints: MediaStreamConstraints = {
          audio: {
            noiseSuppression,
            echoCancellation,
            autoGainControl,
            ...(inputDeviceId && inputDeviceId !== "default"
              ? { deviceId: { exact: inputDeviceId } }
              : {}),
          },
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }

        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);

        micTestStreamRef.current = stream;
        micTestCtxRef.current = ctx;
        micTestSourceRef.current = source;
        micTestAnalyserRef.current = analyser;

        const buffer = new Uint8Array(256);
        const loop = () => {
          if (!micTestAnalyserRef.current) return;
          micTestAnalyserRef.current.getByteTimeDomainData(buffer);
          let sum = 0;
          for (let i = 0; i < buffer.length; i++) {
            const val = (buffer[i] - 128) / 128;
            sum += val * val;
          }
          const rms = Math.sqrt(sum / buffer.length);
          setMicTestLevel(rms);
          micTestRafRef.current = requestAnimationFrame(loop);
        };
        loop();
      } catch (err) {
        console.error("Failed to start mic test", err);
        setMicTestActive(false);
      }
    };

    startTest();

    return () => {
      cancelled = true;
    };
  }, [
    micTestActive,
    noiseSuppression,
    echoCancellation,
    autoGainControl,
    inputDeviceId,
  ]);

  useEffect(() => {
    return () => {
      if (micTestRafRef.current) cancelAnimationFrame(micTestRafRef.current);
      if (micTestSourceRef.current) micTestSourceRef.current.disconnect();
      if (micTestCtxRef.current && micTestCtxRef.current.state !== "closed")
        micTestCtxRef.current.close();
      if (micTestStreamRef.current)
        micTestStreamRef.current.getTracks().forEach((track) => track.stop());
      if (micTestPlaybackUrl) URL.revokeObjectURL(micTestPlaybackUrl);
    };
  }, [micTestPlaybackUrl]);

  const stopMicTest = () => {
    if (micTestRecorderRef.current) {
      micTestRecorderRef.current.stop();
      micTestRecorderRef.current = null;
    }
    if (micTestRafRef.current) cancelAnimationFrame(micTestRafRef.current);
    micTestRafRef.current = null;
    if (micTestSourceRef.current) micTestSourceRef.current.disconnect();
    micTestSourceRef.current = null;
    if (micTestCtxRef.current && micTestCtxRef.current.state !== "closed")
      micTestCtxRef.current.close();
    micTestCtxRef.current = null;
    if (micTestStreamRef.current)
      micTestStreamRef.current.getTracks().forEach((track) => track.stop());
    micTestStreamRef.current = null;
    micTestAnalyserRef.current = null;
    setMicTestLevel(0);
    setMicTestActive(false);
  };

  const runMicCheck = async () => {
    if (micTestRecording) return;
    setMicTestRecording(true);
    if (micTestPlaybackUrl) {
      URL.revokeObjectURL(micTestPlaybackUrl);
      setMicTestPlaybackUrl(null);
    }

    let streamToUse = micTestStreamRef.current;
    let cleanupStream = false;
    try {
      if (!streamToUse) {
        const constraints: MediaStreamConstraints = {
          audio: {
            noiseSuppression,
            echoCancellation,
            autoGainControl,
            ...(inputDeviceId && inputDeviceId !== "default"
              ? { deviceId: { exact: inputDeviceId } }
              : {}),
          },
        };
        streamToUse = await navigator.mediaDevices.getUserMedia(constraints);
        cleanupStream = true;
      }

      const recorder = new MediaRecorder(streamToUse);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, {
          type: recorder.mimeType || "audio/webm",
        });
        const url = URL.createObjectURL(blob);
        setMicTestPlaybackUrl(url);
        setMicTestRecording(false);
        if (cleanupStream && streamToUse) {
          streamToUse.getTracks().forEach((track) => track.stop());
        }
      };
      micTestRecorderRef.current = recorder;
      recorder.start();
      setTimeout(() => {
        if (recorder.state !== "inactive") recorder.stop();
      }, 4000);
    } catch (err) {
      console.error("Mic check failed", err);
      setMicTestRecording(false);
      if (cleanupStream && streamToUse) {
        streamToUse.getTracks().forEach((track) => track.stop());
      }
    }
  };

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    let active = true;

    const loadDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!active) return;
        setInputDevices(
          devices.filter((device) => device.kind === "audioinput"),
        );
        setOutputDevices(
          devices.filter((device) => device.kind === "audiooutput"),
        );
        setDeviceError(null);
      } catch (err) {
        console.error("Failed to enumerate devices", err);
        if (active) setDeviceError("Unable to list audio devices.");
      }
    };

    loadDevices();
    navigator.mediaDevices.addEventListener("devicechange", loadDevices);
    return () => {
      active = false;
      navigator.mediaDevices.removeEventListener("devicechange", loadDevices);
    };
  }, []);

  const renderDeviceLabel = (
    device: MediaDeviceInfo,
    index: number,
    kind: "input" | "output",
  ) => {
    if (device.deviceId === "default") return "Default";
    if (device.label) return device.label;
    return kind === "input"
      ? `Microphone ${index + 1}`
      : `Speaker ${index + 1}`;
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (avatarFile) {
        await updateAvatar(avatarFile);
      }
      await updateProfile({ displayName, bio, status });
      onClose();
    } catch (err) {
      console.error("Failed to update profile", err);
    } finally {
      setSaving(false);
    }
  };

  const currentAvatar =
    avatarPreview ||
    (user.avatarUrl
      ? user.avatarUrl.startsWith("http")
        ? user.avatarUrl
        : `${getApiBase()}${user.avatarUrl}`
      : null);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal user-settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>User Settings</h2>

        <div className="settings-avatar-section">
          <div
            className="settings-avatar"
            onClick={() => fileInputRef.current?.click()}
          >
            {currentAvatar ? (
              <img src={currentAvatar} alt={user.displayName} />
            ) : (
              <span className="settings-avatar-letter">
                {user.displayName.charAt(0).toUpperCase()}
              </span>
            )}
            <div className="settings-avatar-overlay">Change</div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: "none" }}
            onChange={handleAvatarChange}
          />
        </div>

        <label>
          Display Name
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={32}
          />
        </label>

        <label>
          Bio
          <textarea
            className="settings-textarea"
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            maxLength={190}
            rows={3}
            placeholder="Tell us about yourself"
          />
        </label>

        <label>
          Status
          <input
            type="text"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            maxLength={32}
          />
        </label>

        <label>
          Voice Mode
          <div className="channel-type-select">
            <button
              type="button"
              className={`type-option ${voiceMode === "voice-activity" ? "active" : ""}`}
              onClick={() => setVoiceMode("voice-activity")}
            >
              Voice Activity
            </button>
            <button
              type="button"
              className={`type-option ${voiceMode === "push-to-talk" ? "active" : ""}`}
              onClick={() => setVoiceMode("push-to-talk")}
            >
              Push to Talk
            </button>
          </div>
        </label>

        {voiceMode === "push-to-talk" && (
          <label>
            PTT Key
            <button
              type="button"
              className={`ptt-key-capture ${capturingKey ? "recording" : ""}`}
              onClick={() => setCapturingKey(true)}
            >
              {capturingKey
                ? "Press any key or mouse button..."
                : pttKey.startsWith("Mouse")
                  ? `Mouse Button ${pttKey.slice(5)}`
                  : pttKey}
            </button>
          </label>
        )}

        <div className="settings-section">
          <div className="settings-section-title">Audio Processing</div>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={noiseSuppression}
              onChange={(e) => setNoiseSuppression(e.target.checked)}
            />
            ANTI-WILL BREATHING TECHNOLOGY
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={echoCancellation}
              onChange={(e) => setEchoCancellation(e.target.checked)}
            />
            Echo Cancellation
          </label>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={autoGainControl}
              onChange={(e) => setAutoGainControl(e.target.checked)}
            />
            Auto Gain Control
          </label>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Mic Test</div>
          <div className="settings-mic-test">
            <button
              type="button"
              className="btn-secondary"
              onClick={() =>
                micTestActive ? stopMicTest() : setMicTestActive(true)
              }
            >
              {micTestActive ? "Stop Test" : "Start Test"}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={runMicCheck}
              disabled={micTestRecording}
            >
              {micTestRecording ? "Recording..." : "Let's Check"}
            </button>
            <div className="mic-level">
              <div
                className="mic-level-fill"
                style={{
                  width: `${Math.min(100, Math.round(micTestLevel * 240))}%`,
                }}
              />
            </div>
          </div>
          <div className="settings-help">
            Speak and adjust sensitivity so normal speech is steady without
            peaking.
          </div>
          {micTestPlaybackUrl && (
            <audio className="mic-playback" controls src={micTestPlaybackUrl} />
          )}
        </div>

        <div className="settings-section">
          <div className="settings-section-title">Input Sensitivity</div>
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(inputSensitivity * 100)}
            onChange={(e) => setInputSensitivity(Number(e.target.value) / 100)}
            className="settings-range"
          />
          <div className="settings-range-labels">
            <span>Low</span>
            <span>{Math.round(inputSensitivity * 100)}%</span>
            <span>High</span>
          </div>
          <div className="settings-help">
            Higher sensitivity picks up quieter sounds.
          </div>
        </div>

        <label>
          Input Device
          <select
            className="settings-select"
            value={inputDeviceId}
            onChange={(e) => setInputDeviceId(e.target.value)}
            disabled={!navigator.mediaDevices?.enumerateDevices}
          >
            <option value="default">Default</option>
            {inputDevices.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {renderDeviceLabel(device, index, "input")}
              </option>
            ))}
          </select>
        </label>

        <label>
          Output Device
          <select
            className="settings-select"
            value={outputDeviceId}
            onChange={(e) => setOutputDeviceId(e.target.value)}
            disabled={!canSelectOutput}
          >
            <option value="default">Default</option>
            {outputDevices.map((device, index) => (
              <option key={device.deviceId} value={device.deviceId}>
                {renderDeviceLabel(device, index, "output")}
              </option>
            ))}
          </select>
          {!canSelectOutput && (
            <div className="settings-help">
              Output selection isn&apos;t supported in this browser.
            </div>
          )}
          {deviceError && <div className="settings-help">{deviceError}</div>}
        </label>

        <div className="settings-section">
          <div className="settings-section-title">Account</div>
          <div className="danger-zone">
            <p>Sign out of this device.</p>
            <button className="btn-danger" type="button" onClick={logout}>
              Log Out
            </button>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
