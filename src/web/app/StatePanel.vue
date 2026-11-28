<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    kind?: 'empty' | 'error'
    title: string
    message?: string
    glyph?: string
    compact?: boolean
  }>(),
  { kind: 'empty', message: '', glyph: '', compact: false },
)

const role = computed(() => (props.kind === 'error' ? 'alert' : undefined))
</script>

<template>
  <div class="mo-state" :class="{ compact, error: kind === 'error' }" :role="role">
    <div v-if="glyph" class="mo-state-glyph" aria-hidden="true">{{ glyph }}</div>
    <p class="mo-state-title">{{ title }}</p>
    <p v-if="message" class="muted mo-state-message">{{ message }}</p>
    <div v-if="$slots.default" class="mo-state-actions">
      <slot />
    </div>
  </div>
</template>
