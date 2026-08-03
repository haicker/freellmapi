// Model type classification — heuristically categorize a model id from a
// provider's /v1/models listing into one of five kinds so the discovery flow
// can route it to the correct database table (models / embedding_models /
// media_models) instead of dumping every model into the chat catalog.
//
// Aggregators like OpenRouter and SiliconFlow mix chat, embedding, image, and
// audio models in a single /v1/models response. Without classification, an
// embedding model (e.g. text-embedding-3-small) or an image model (e.g.
// flux-1-schnell) would be inserted into the `models` table and the chat router
// could pick it for a chat completion — which fails because the model doesn't
// speak the chat protocol.
//
// The patterns below are intentionally conservative: a model is only classified
// as non-chat when its id strongly matches a known naming convention. Unknown
// ids default to 'chat', which is the safe fallback (most models in a /v1/models
// listing ARE chat models, and a misclassified chat model is harmless — it just
// won't appear in the chat catalog until manually re-added).

export type ModelKind = 'chat' | 'embedding' | 'image' | 'audio' | 'video';

/** All non-chat kinds, for filters that want to exclude chat. */
export const NON_CHAT_KINDS: ReadonlySet<ModelKind> = new Set(['embedding', 'image', 'audio', 'video']);

// ── Embedding models ────────────────────────────────────────────────────────
//
// Embedding model ids almost always contain "embed" (text-embedding-3-small,
// gemini-embedding-001, mistral-embed, jina-embeddings-v3, nomic-embed-text,
// snowflake-arctic-embed, nv-embed-v1). The BGE / GTE / E5 families use their
// own prefixes without the word "embed", so they are listed explicitly.
const EMBEDDING_PATTERNS: RegExp[] = [
  /embed/i,                       // text-embedding-*, *-embed-*, embedding-*
  /(?:^|\/)bge[-.]/i,             // BAAI/bge-base-en, bge-m3
  /(?:^|\/)gte[-.]/i,             // gte-Qwen2-1.5B, gte-large
  /(?:^|\/)e5[-.]/i,              // intfloat/e5-*, multilingual-e5-*
  /(?:^|\/)qwen3[-.]embedding/i,  // Qwen3-Embedding-0.6B etc.
];

// ── Image generation models ─────────────────────────────────────────────────
const IMAGE_PATTERNS: RegExp[] = [
  /(?:^|\/)dall-e/i,              // OpenAI dall-e-2, dall-e-3
  /(?:^|\/)stable-diffusion/i,    // stable-diffusion-xl, stable-diffusion-3
  /(?:^|\/)sdxl/i,                // sdxl, sdxl-turbo
  /(?:^|\/)flux/i,                // FLUX.1-schnell, FLUX.1-dev, black-forest-labs/flux-1
  /(?:^|\/)imagen/i,              // Google imagen-3.0, imagen-4.0
  /(?:^|\/)kolors/i,              // Kolors
  /(?:^|\/)seedream/i,            // ByteDance seedream-3.0
  /(?:^|\/)deepfloyd/i,           // DeepFloyd IF
  /(?:^|\/)stable\.image/i,       // stability.ai/stable.image
];

// ── Video generation models ─────────────────────────────────────────────────
//
// Note: "video understanding" chat models (e.g. qwen2-vl, reka-edge) are NOT
// video generation models — they accept video input but produce text. We only
// match video *generation* model prefixes here.
const VIDEO_PATTERNS: RegExp[] = [
  /(?:^|\/)sora/i,                // OpenAI sora-2, sora-turbo
  /(?:^|\/)veo/i,                 // Google veo-3, veo-2
  /(?:^|\/)kling/i,               // Kuaishou kling-v1, kling-v2
  /(?:^|\/)wan[.-]?[0-9]/i,       // Alibaba wan2.1, wan-2.2
  /hunyuan.video/i,               // Tencent hunyuan-video
  /(?:^|\/)cogvideo/i,            // Zhipu cogvideox
  /(?:^|\/)video[-.](?:0|gen)/i,  // minimax/video-01, video-gen-*
  /text.to.video/i,               // generic text-to-video-synthesis
];

// ── Audio / TTS models ──────────────────────────────────────────────────────
//
// We deliberately do NOT match the bare word "audio" — multimodal chat models
// like gpt-4o-audio-preview and qwen2-audio accept audio input but are chat
// models, not TTS. We match specific TTS / speech-synthesis prefixes instead.
const AUDIO_PATTERNS: RegExp[] = [
  /tts/i,                         // tts-1, tts-1-hd, gpt-4o-mini-tts, f5-tts
  /whisper/i,                     // whisper-1 (speech-to-text)
  /(?:^|\/)bark/i,                // Bark TTS
  /cosyvoice/i,                   // CosyVoice TTS
  /fish-speech/i,                 // Fish Speech TTS
  /speech.*synth/i,               // speech-synthesis-*
];

/**
 * Classify a model id into its kind. Returns 'chat' for anything that doesn't
 * match a known non-chat pattern — this is the safe default because the
 * majority of models in a /v1/models listing are chat models, and a chat model
 * accidentally left out of the chat catalog is a minor inconvenience while a
 * non-chat model accidentally placed in the chat catalog breaks routing.
 */
export function classifyModel(modelId: string): ModelKind {
  const id = modelId.toLowerCase();
  if (EMBEDDING_PATTERNS.some(re => re.test(id))) return 'embedding';
  if (IMAGE_PATTERNS.some(re => re.test(id))) return 'image';
  if (VIDEO_PATTERNS.some(re => re.test(id))) return 'video';
  if (AUDIO_PATTERNS.some(re => re.test(id))) return 'audio';
  return 'chat';
}
