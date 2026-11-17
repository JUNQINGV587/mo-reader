<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

const props = defineProps<{
  src: string
  title?: string
  bookName?: string
  initialPosition?: number
}>()

const emit = defineEmits<{
  (e: 'progress', seconds: number): void
  (e: 'ended'): void
}>()

const audio = ref<HTMLAudioElement | null>(null)
const failed = ref(false)

function seekToStart() {
  const el = audio.value
  if (!el) return
  const start = Number(props.initialPosition ?? 0)
  if (start > 0 && Number.isFinite(start)) {
    try {
      el.currentTime = start
    } catch {
      // 元数据未就绪时忽略
    }
  }
}

function onTimeUpdate() {
  const el = audio.value
  if (el) emit('progress', Math.floor(el.currentTime || 0))
}

onMounted(() => {
  const el = audio.value
  if (!el) return
  el.addEventListener('loadedmetadata', seekToStart)
  seekToStart()
})

watch(
  () => props.src,
  () => {
    failed.value = false
    const el = audio.value
    if (el) {
      el.load()
      seekToStart()
    }
  },
)
</script>

<template>
  <div class="mo-audio" data-testid="audio-reader">
    <div class="mo-audio-card">
      <div class="mo-audio-cover" aria-hidden="true">♪</div>
      <div class="mo-audio-meta">
        <strong>{{ bookName || '音频' }}</strong>
        <span>{{ title || '当前章节' }}</span>
      </div>
      <audio
        ref="audio"
        :src="src"
        controls
        preload="metadata"
        @timeupdate="onTimeUpdate"
        @ended="emit('ended')"
        @error="failed = true"
      />
      <p v-if="failed" class="mo-audio-error">音频加载失败：{{ src }}</p>
    </div>
  </div>
</template>

<style scoped>
.mo-audio {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 24px;
  background: var(--mo-paper, #f8f5ee);
}
.mo-audio-card {
  width: min(420px, 90%);
  padding: 24px;
  border: 1px solid var(--mo-line, #e2dccf);
  border-radius: 16px;
  background: #fffdf8;
  text-align: center;
}
.mo-audio-cover {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 96px;
  height: 96px;
  margin: 0 auto 16px;
  border-radius: 50%;
  background: #3d6b53;
  color: #f6f1e7;
  font-size: 40px;
}
.mo-audio-meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 18px;
  color: var(--mo-ink, #26231d);
}
.mo-audio-meta span {
  font-size: 13px;
  color: var(--mo-muted, #8a8377);
}
.mo-audio audio {
  width: 100%;
}
.mo-audio-error {
  margin-top: 12px;
  font-size: 12px;
  color: #a8402e;
  word-break: break-all;
}
</style>
