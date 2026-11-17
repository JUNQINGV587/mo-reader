<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'

const props = defineProps<{
  images: string[]
  title?: string
  initialPage?: number
}>()

const emit = defineEmits<{
  (e: 'page', payload: { page: number; total: number }): void
}>()

const scroller = ref<HTMLElement | null>(null)
const current = ref(0)

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
</template>

<style scoped>
.mo-comic {
  position: relative;
  width: 100%;
  height: 100%;
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
