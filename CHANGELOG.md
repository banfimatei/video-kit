# Changelog

## Unreleased

- Word alignment uses Groq speech-to-text (`whisper-large-v3-turbo`,
  `POST https://api.groq.com/openai/v1/audio/transcriptions`, `verbose_json`
  word timestamps) when `GROQ_API_KEY` is set. `DEEPGRAM_API_KEY` no longer
  times words. Cached `.words.json` sidecars from the previous aligner
  (Deepgram nova-3, unversioned) are stale: the sidecar `version` is now 2,
  so those files are aligned again.
- Deepgram is no longer a TTS provider. `tts: "deepgram"` (Aura-2 and Flux)
  is rejected. Voices stay on ElevenLabs, OpenAI, Gemini, OpenRouter, or espeak.
