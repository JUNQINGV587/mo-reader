<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  images: string[]
  title?: string
  initialPage?: number
  /** 当前读的是本地离线文件还是在线代理。 */
  local?: boolean
}>()

const emit = defineEmits<{
  (e: 'page', payload: { page: number; total: number }): void
  (e: 'mediaError', payload?: { reason?: string; permanent?: boolean }): void
}>()

const scroller = ref<HTMLElement | null>(null)
const current = ref(0)
/** 加载失败的图片张数：大于 0 时在顶部显示明确的错误条，避免整章静默变黑。 */
const broken = ref(0)
/** 一批图片只上报一次错误，避免一张坏图触发多次在线回退。 */
let reported = false

function clamp(value: number): number {
  return Math.max(0, Math.min(props.images.length - 1, value))
}

function scrollToPage(page: number) {
  const box = scroller.value
  const target = box?.children[clamp(page)] as HTMLElement | undefined
  if (box && target) box.scrollTop = target.offsetTop
}

function syncPage() {
  const box = scroller.value
  if (!box || !props.images.length) return
  const middle = box.scrollTop + box.clientHeight / 2
  let index = 0
  for (let i = 0; i < box.children.length; i += 1) {
    const el = box.children[i] as HTMLElement
    if (el.offsetTop <= middle) index = i
    else break
  }
  if (index !== current.value) {
    current.value = index
    emit('page', { page: index, total: props.images.length })
  }
}

function markBroken(event: Event) {
  const el = event.target as HTMLImageElement
  el.style.opacity = '0.2'
  broken.value += 1
  if (!reported) {
    reported = true
    emit('mediaError', { reason: `${broken.value} 张图片加载失败` })
  }
}

onMounted(() => {
  nextTick(() => {
    scrollToPage(props.initialPage ?? 0)
    syncPage()
  })
})

watch(
  () => props.images,
  () => {
    current.value = 0
    broken.value = 0
    reported = false
    nextTick(() => {
      scrollToPage(0)
      emit('page', { page: 0, total: props.images.length })
    })
  },
)

watch(
  () => props.initialPage,
  (page) => {
    if (typeof page === 'number') scrollToPage(page)
  },
)
</script>

<template>
  <div class="mo-comic-wrap">
    <p class="mo-comic-source">
      <span class="mo-comic-badge" data-testid="media-source-label">{{ local ? '本地' : '在线' }}</span>
    </p>
    <p v-if="broken" class="mo-comic-error" data-testid="comic-error" role="alert">
      部分图片加载失败，请检查网络后重试（{{ broken }} / {{ images.length }} 页）
    </p>
    <div ref="scroller" class="mo-comic" data-testid="comic-reader" @scroll.passive="syncPage">
      <div v-if="title" class="mo-comic-title">{{ title }}</div>
      <img
        v-for="(src, index) in images"
        :key="`${index}-${src}`"
        :src="src"
        :alt="`第 ${index + 1} 页`"
        loading="lazy"
        decoding="async"
        @error="markBroken"
      />
      <p v-if="!images.length" class="mo-comic-empty">（本章没有图片）</p>
    </div>
  </div>
</template>

<style scoped>
.mo-comic-wrap {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}
.mo-comic-source {
  flex: 0 0 auto;
  margin: 0;
  padding: 4px 16px;
  font-size: 12px;
  color: #9a958c;
  background: #101114;
}
.mo-comic-badge {
  padding: 1px 8px;
  border: 1px solid #3a3d44;
  border-radius: 999px;
}
.mo-comic-error {
  flex: 0 0 auto;
  margin: 0;
  padding: 8px 16px;
  font-size: 13px;
  color: #ffb4a2;
  text-align: center;
  background: #3a1d1f;
}
.mo-comic {
  position: relative;
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  overflow-y: auto;
  background: #101114;
  scrollbar-width: thin;
}
.mo-comic-title {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 10px 16px;
  font-size: 13px;
  color: #f2efe8;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0));
  pointer-events: none;
}
.mo-comic img {
  display: block;
  width: 100%;
  max-width: 900px;
  margin: 0 auto 2px;
  background: #1b1d22;
  transition: opacity 0.2s;
}
.mo-comic-empty {
  padding: 48px 16px;
  color: #9a958c;
  text-align: center;
}
</style>
