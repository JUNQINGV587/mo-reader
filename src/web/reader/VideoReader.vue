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

const video = ref<HTMLVideoElement | null>(null)
const failed = ref(false)

function seekToStart() {
  const el = video.value
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
  const el = video.value
  if (el) emit('progress', Math.floor(el.currentTime || 0))
}

onMounted(() => {
  const el = video.value
  if (!el) return
  el.addEventListener('loadedmetadata', seekToStart)
  seekToStart()
})

watch(
  () => props.src,
  () => {
    failed.value = false
    const el = video.value
    if (el) {
      el.load()
      seekToStart()
    }
  },
)
</script>

<template>
  <div class="mo-video" data-testid="video-reader">
    <div class="mo-video-head">
      <strong>{{ bookName || '视频' }}</strong>
      <span>{{ title || '当前章节' }}</span>
    </div>
    <video
      ref="video"
      :src="src"
      controls
      playsinline
      preload="metadata"
      @timeupdate="onTimeUpdate"
      @ended="emit('ended')"
      @error="failed = true"
    />
    <p v-if="failed" class="mo-video-error">视频加载失败：{{ src }}</p>
  </div>
</template>

<style scoped>
.mo-video {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  height: 100%;
  padding: 16px;
  background: #101114;
}
.mo-video-head {
  display: flex;
  gap: 10px;
  align-items: baseline;
  align-self: stretch;
  padding: 0 4px 12px;
  color: #f2efe8;
}
.mo-video-head span {
  font-size: 12px;
  color: #9a958c;
}
.mo-video video {
  width: 100%;
  max-width: 960px;
  max-height: calc(100% - 40px);
  background: #000;
}
.mo-video-error {
  margin-top: 12px;
  font-size: 12px;
  color: #ff8a7a;
  word-break: break-all;
}
</style>
