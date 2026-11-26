<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import Hls from 'hls.js'

const props = defineProps<{
  src: string
  title?: string
  bookName?: string
  initialPosition?: number
  /** 当前播放的是本地离线文件还是在线代理。 */
  local?: boolean
}>()

const emit = defineEmits<{
  (e: 'progress', seconds: number): void
  (e: 'ended'): void
  (e: 'mediaError'): void
}>()

const audio = ref<HTMLAudioElement | null>(null)
const failed = ref(false)
let hls: Hls | null = null
/** 一次播放只上报一次错误，避免在线回退也失败时反复触发。 */
let reported = false

function markFailed() {
  failed.value = true
  if (!reported) {
    reported = true
    emit('mediaError')
  }
}

const isHls = computed(() => /\.m3u8(\?|#|$)/i.test(props.src || ''))
const looksLikeMedia = computed(() => /\.(m3u8|mp3|m4a|aac|ogg|wav|flac)(\?|#|$)/i.test(props.src || ''))
const externalOnly = computed(() => !!props.src && !looksLikeMedia.value && /\/player\?|jx\.|vodplay/i.test(props.src))

function destroyHls() {
  if (hls) {
    hls.destroy()
    hls = null
  }
}

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

function attach() {
  const el = audio.value
  if (!el) return
  destroyHls()
  failed.value = false
  reported = false
  el.removeAttribute('src')
  el.load()
  const src = props.src || ''
  if (!src || externalOnly.value) return
  if (isHls.value && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true })
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (data?.fatal) markFailed()
    })
    hls.loadSource(src)
    hls.attachMedia(el)
  } else {
    el.src = src
  }
}

function onTimeUpdate() {
  const el = audio.value
  if (el) emit('progress', Math.floor(el.currentTime || 0))
}

onMounted(() => {
  attach()
  audio.value?.addEventListener('loadedmetadata', seekToStart)
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
  <div class="mo-audio" data-testid="audio-reader">
    <div class="mo-audio-card">
      <div class="mo-audio-cover" aria-hidden="true">♪</div>
      <div class="mo-audio-meta">
        <strong>{{ bookName || '音频' }}</strong>
        <span>{{ title || '当前章节' }}</span>
        <em class="mo-audio-source" data-testid="media-source-label">{{ local ? '本地' : '在线' }}</em>
      </div>
      <div v-if="externalOnly" class="mo-audio-external">
        <p>该源返回的是网页播放器，无法内嵌播放。</p>
        <a :href="src" target="_blank" rel="noreferrer">在浏览器打开播放页</a>
      </div>
      <audio
        v-else
        ref="audio"
        controls
        preload="metadata"
        @timeupdate="onTimeUpdate"
        @ended="emit('ended')"
        @error="markFailed"
      />
      <p v-if="failed" class="mo-audio-error" data-testid="audio-error">音频加载失败（代理播放失败或网络异常）：{{ src }}</p>
      <a v-if="failed" class="mo-audio-link" :href="src" target="_blank" rel="noreferrer">在浏览器打开</a>
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
.mo-audio-source {
  align-self: center;
  padding: 1px 10px;
  border: 1px solid #d8d2c4;
  border-radius: 999px;
  font-size: 12px;
  font-style: normal;
  color: #6d675c;
}
.mo-audio audio {
  width: 100%;
}
.mo-audio-external {
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--mo-ink, #26231d);
}
.mo-audio-external a,
.mo-audio-link {
  color: #3d6b53;
  font-size: 13px;
}
.mo-audio-error {
  margin-top: 12px;
  font-size: 12px;
  color: #a8402e;
  word-break: break-all;
}
</style>
