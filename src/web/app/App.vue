<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

const props = defineProps<{ remote?: any; layout?: any }>()

const tabs = [
  { id: 'shelf', label: '书架' },
  { id: 'discover', label: '发现' },
  { id: 'subscribe', label: '订阅' },
  { id: 'mine', label: '我的' },
]

const active = ref('shelf')
const status = ref('正在连接服务…')
const version = ref('')
const activeLabel = computed(() => tabs.find((tab) => tab.id === active.value)?.label ?? '')

onMounted(async () => {
  try {
    const res = await props.remote?.state?.({})
    version.value = res?.version ?? ''
    status.value = res?.ok ? `服务已连接 · ${res.version}` : '服务未就绪'
  } catch (error: any) {
    status.value = `服务未连接：${error?.message ?? String(error)}`
  }
})
</script>

<template>
  <div class="mo-app">
    <header class="mo-head">
      <div class="mo-brand">
        <span class="mo-seal">墨</span>
        <span class="mo-name">墨读</span>
        <span class="mo-tag">复刻「阅读」</span>
      </div>
      <span class="mo-version">{{ version || 'M0' }}</span>
    </header>

    <div class="mo-body">
      <nav class="mo-nav" aria-label="墨读导航">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="mo-nav-item"
          :class="{ active: tab.id === active }"
          @click="active = tab.id"
        >
          {{ tab.label }}
        </button>
      </nav>

      <main class="mo-main">
        <div class="mo-card">
          <h2 class="mo-title">{{ activeLabel }}</h2>
          <p class="mo-status">{{ status }}</p>
          <p class="mo-hint">M0 只验证 DSH 面板、Remote 与存储骨架；书架、发现、订阅与阅读页从 M1 起接入。</p>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.mo-app {
  display: flex;
  flex-direction: column;
  min-height: 320px;
  height: 100%;
  font-family: system-ui, -apple-system, 'PingFang SC', 'Noto Sans SC', sans-serif;
  color: var(--dsw-alias-label-primary, #1f2421);
  background: var(--dsw-alias-bg-layer-1, #faf9f6);
}
.mo-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
}
.mo-brand {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mo-seal {
  display: inline-flex;
  width: 26px;
  height: 26px;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: #a8402e;
  color: #f8f1e4;
  font-size: 15px;
  font-weight: 700;
}
.mo-name {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.mo-tag,
.mo-version {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, #7b8078);
}
.mo-body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.mo-nav {
  flex: none;
  width: 148px;
  padding: 12px 10px;
  border-right: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
}
.mo-nav-item {
  display: block;
  width: 100%;
  margin-bottom: 4px;
  padding: 8px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.mo-nav-item.active {
  background: rgba(61, 107, 83, 0.12);
  color: #2c5140;
  font-weight: 600;
}
.mo-main {
  flex: 1;
  min-width: 0;
  padding: 20px;
  overflow: auto;
}
.mo-card {
  max-width: 560px;
  padding: 20px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.08));
  border-radius: 12px;
}
.mo-title {
  margin: 0 0 8px;
  font-size: 18px;
}
.mo-status {
  margin: 0 0 10px;
  font-size: 13px;
  color: #2c5140;
}
.mo-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--dsw-alias-label-secondary, #7b8078);
}
</style>
