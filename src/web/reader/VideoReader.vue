<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import Hls from 'hls.js'

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
let hls: Hls | null = null

const isHls = computed(() => /\.m3u8(\?|#|$)/i.test(props.src || ''))
const looksLikeMedia = computed(() => /\.(m3u8|mp4|webm|ogg|flv|mkv)(\?|#|$)/i.test(props.src || ''))
const externalOnly = computed(() => !!props.src && !looksLikeMedia.value && /\/player\?|jx\.|vodplay/i.test(props.src))

function destroyHls() {
  if (hls) {
    hls.destroy()
    hls = null
  }
}

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

function attach() {
  const el = video.value
  if (!el) return
  destroyHls()
  failed.value = false
  el.removeAttribute('src')
  el.load()
  const src = props.src || ''
  if (!src || externalOnly.value) return
  if (isHls.value && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true })
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) failed.value = true
    })
    hls.loadSource(src)
    hls.attachMedia(el)
  } else {
    el.src = src
  }
}

function onTimeUpdate() {
  const el = video.value
  if (el) emit('progress', Math.floor(el.currentTime || 0))
}

onMounted(() => {
  attach()
  video.value?.addEventListener('loadedmetadata', seekToStart)
})

watch(
  () => props.src,
  () => {
    attach()
    seekToStart()
  },
)

onUnmounted(destroyHls)
</script>

<template>
  <div class="mo-video" data-testid="video-reader">
    <div class="mo-video-head">
      <strong>{{ bookName || '视频' }}</strong>
      <span>{{ title || '当前章节' }}</span>
    </div>
    <div v-if="externalOnly" class="mo-video-external">
      <p>该源返回的是网页播放器，无法内嵌播放。</p>
      <a :href="src" target="_blank" rel="noreferrer">在浏览器打开播放页</a>
    </div>
    <video
      v-else
      ref="video"
      controls
      playsinline
      preload="metadata"
      @timeupdate="onTimeUpdate"
      @ended="emit('ended')"
      @error="failed = true"
    />
    <p v-if="failed" class="mo-video-error" data-testid="video-error">视频加载失败（代理播放失败或网络异常）：{{ src }}</p>
    <a v-if="failed" class="mo-video-link" :href="src" target="_blank" rel="noreferrer">在浏览器打开</a>
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
.mo-video-external {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  margin-top: 64px;
  color: #d8d4c8;
}
.mo-video-external a,
.mo-video-link {
  color: #9ec7b0;
  font-size: 13px;
}
.mo-video-error {
  margin-top: 12px;
  font-size: 12px;
  color: #ff8a7a;
  word-break: break-all;
}
</style>
