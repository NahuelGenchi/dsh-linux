// Test helper: runs the bundled speech engine on a real recording, as the app's voice worker does.
//   ELECTRON_RUN_AS_NODE=1 deepseek-harness test/voice.mjs <resources> <folder with the model files and a .wav>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const [resources, folder, wav = 'en.wav'] = process.argv.slice(2);
const require = createRequire(join(resources, 'app.asar', 'dsh', 'package.json'));
const sherpa = require('sherpa-onnx-node');
const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: { senseVoice: { model: join(folder, 'model.int8.onnx'), language: 'auto', useInverseTextNormalization: 1 }, tokens: join(folder, 'tokens.txt'), numThreads: 2, provider: 'cpu', debug: 0 },
});
new sherpa.Vad({ sileroVad: { model: join(folder, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.5, minSpeechDuration: 0.25, maxSpeechDuration: 20, windowSize: 512 }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: 0 }, 30);
const audio = readFileSync(join(folder, wav));
const pcm = new DataView(audio.buffer, audio.byteOffset + 44, audio.byteLength - 44);
const samples = Float32Array.from({ length: pcm.byteLength / 2 }, (_, i) => pcm.getInt16(i * 2, true) / 32768);
const stream = recognizer.createStream();
stream.acceptWaveform({ sampleRate: 16000, samples });
const started = performance.now();
recognizer.decode(stream);
console.log(JSON.stringify({ wav, seconds: samples.length / 16000, decodeMs: Math.round(performance.now() - started), text: recognizer.getResult(stream).text }));
