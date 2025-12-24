// פונקציה להכנת אודיו שנשלח לגוגל
export const createPcmBlob = (data: Float32Array): Blob => {
  const pcm16 = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    pcm16[i] = Math.max(-1, Math.min(1, data[i])) * 0x7FFF;
  }
  return new Blob([pcm16.buffer], { type: 'audio/pcm' });
};

// ✅ פונקציה קריטית: הופכת Base64 לצליל שהאווטאר משמיע
export const decodeAudioData = async (ctx: AudioContext, base64Data: string): Promise<AudioBuffer> => {
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  // גוגל שולחת PCM ב-24kHz מונו
  const pcm16 = new Int16Array(bytes.buffer);
  const float32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    float32[i] = pcm16[i] / 0x7FFF;
  }
  
  const buffer = ctx.createBuffer(1, float32.length, 24000);
  buffer.getChannelData(0).set(float32);
  return buffer;
};
