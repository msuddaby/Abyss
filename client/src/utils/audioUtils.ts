export function encodeWav(
  audioBuffer: AudioBuffer,
  startSample = 0,
  endSample = audioBuffer.length,
): ArrayBuffer {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const numSamples = endSample - startSample;
  const bytesPerSample = 2; // 16-bit PCM
  const dataSize = numSamples * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: numChannels }, (_, i) => audioBuffer.getChannelData(i));
  let offset = 44;
  for (let i = startSample; i < endSample; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return buffer;
}

export function audioBufferToWavFile(
  audioBuffer: AudioBuffer,
  fileName: string,
  startTime = 0,
  endTime = audioBuffer.duration,
): File {
  const startSample = Math.round(startTime * audioBuffer.sampleRate);
  const endSample = Math.round(endTime * audioBuffer.sampleRate);
  const wavBuffer = encodeWav(audioBuffer, startSample, endSample);
  const wavName = fileName.replace(/\.[^.]+$/, '.wav');
  return new File([wavBuffer], wavName, { type: 'audio/wav' });
}
