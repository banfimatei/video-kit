/**
 * Decode an audio file to mono float samples, for the beat tracker.
 * mediabunny sniffs the bytes, so a WAV cached under an .mp3 name still reads.
 */
import { ALL_FORMATS, AudioSampleSink, FilePathSource, Input } from "mediabunny";

export async function readMonoPcm(file: string): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  const input = new Input({ source: new FilePathSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) return null;
    // AudioSample, not AudioBuffer: Node has no Web Audio API.
    const sink = new AudioSampleSink(track);
    const chunks: Float32Array[] = [];
    let sampleRate = 0;
    let total = 0;
    for await (const sample of sink.samples()) {
      try {
        sampleRate = sample.sampleRate;
        const frames = sample.numberOfFrames;
        const channels = sample.numberOfChannels;
        const mono = new Float32Array(frames);
        const plane = new Float32Array(sample.allocationSize({ planeIndex: 0, format: "f32-planar" }) / 4);
        for (let c = 0; c < channels; c++) {
          sample.copyTo(plane, { planeIndex: c, format: "f32-planar" });
          for (let i = 0; i < frames; i++) mono[i] += plane[i] / channels;
        }
        chunks.push(mono);
        total += frames;
      } finally {
        sample.close();
      }
    }
    if (!sampleRate || total === 0) return null;
    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    return { samples, sampleRate };
  } finally {
    input.dispose();
  }
}
