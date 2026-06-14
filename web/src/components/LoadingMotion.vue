<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    variant?: "infinity" | "spinner" | "dots";
    size?: "sm" | "md" | "lg";
    label?: string;
    tone?: "primary" | "neutral" | "warning";
    stacked?: boolean;
  }>(),
  {
    variant: "infinity",
    size: "md",
    label: "",
    tone: "primary",
    stacked: true,
  },
);

const wrapperClass = computed(() => [
  "dd-loading-motion",
  `dd-loading-motion--${props.variant}`,
  `dd-loading-motion--${props.size}`,
  `dd-loading-motion--${props.tone}`,
  { "is-stacked": props.stacked, "has-label": !!props.label },
]);
</script>

<template>
  <div :class="wrapperClass" role="status" aria-live="polite">
    <div
      v-if="variant === 'infinity'"
      class="dd-loading-motion__infinity"
      aria-hidden="true"
    >
      <span class="loop loop--left"></span>
      <span class="loop loop--right"></span>
    </div>

    <div
      v-else-if="variant === 'spinner'"
      class="dd-loading-motion__spinner"
      aria-hidden="true"
    ></div>

    <div v-else class="dd-loading-motion__dots" aria-hidden="true">
      <span></span>
      <span></span>
      <span></span>
    </div>

    <span v-if="label" class="dd-loading-motion__label">{{ label }}</span>
  </div>
</template>

<style scoped lang="scss">
.dd-loading-motion {
  --dd-loading-color: var(--el-color-primary);
  --dd-loading-text-color: var(--el-text-color-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 10px;

  &.is-stacked {
    flex-direction: column;
  }

  &--neutral {
    --dd-loading-color: color-mix(
      in srgb,
      var(--el-text-color-secondary) 92%,
      transparent
    );
  }

  &--warning {
    --dd-loading-color: var(--el-color-warning);
  }
}

.dd-loading-motion__label {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dd-loading-text-color);
}

.dd-loading-motion__spinner,
.dd-loading-motion__infinity,
.dd-loading-motion__dots {
  flex-shrink: 0;
}

.dd-loading-motion--sm {
  .dd-loading-motion__spinner {
    width: 14px;
    height: 14px;
    border-width: 1.8px;
  }

  .dd-loading-motion__dots span {
    width: 5px;
    height: 5px;
  }

  .dd-loading-motion__infinity {
    width: 30px;
    height: 14px;
  }

  .dd-loading-motion__infinity .loop {
    width: 12px;
    height: 12px;
    border-width: 1.8px;
  }

  .dd-loading-motion__label {
    font-size: 12px;
  }
}

.dd-loading-motion--md {
  .dd-loading-motion__spinner {
    width: 18px;
    height: 18px;
    border-width: 2px;
  }

  .dd-loading-motion__dots span {
    width: 6px;
    height: 6px;
  }

  .dd-loading-motion__infinity {
    width: 40px;
    height: 18px;
  }

  .dd-loading-motion__infinity .loop {
    width: 16px;
    height: 16px;
    border-width: 2px;
  }
}

.dd-loading-motion--lg {
  .dd-loading-motion__spinner {
    width: 26px;
    height: 26px;
    border-width: 2.4px;
  }

  .dd-loading-motion__dots span {
    width: 8px;
    height: 8px;
  }

  .dd-loading-motion__infinity {
    width: 56px;
    height: 24px;
  }

  .dd-loading-motion__infinity .loop {
    width: 22px;
    height: 22px;
    border-width: 2.6px;
  }

  .dd-loading-motion__label {
    font-size: 14px;
  }
}

.dd-loading-motion__spinner {
  border-style: solid;
  border-color: color-mix(in srgb, var(--dd-loading-color) 18%, transparent);
  border-top-color: color-mix(
    in srgb,
    var(--dd-loading-color) 92%,
    transparent
  );
  border-radius: 999px;
  animation: dd-loading-spin 0.82s linear infinite;
}

.dd-loading-motion__dots {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;

  span {
    display: inline-block;
    border-radius: 999px;
    background: var(--dd-loading-color);
    animation: dd-loading-dot-pulse 1.05s ease-in-out infinite;
  }

  span:nth-child(2) {
    animation-delay: 0.16s;
  }

  span:nth-child(3) {
    animation-delay: 0.32s;
  }
}

.dd-loading-motion__infinity {
  position: relative;

  .loop {
    position: absolute;
    top: 50%;
    border-style: solid;
    border-color: color-mix(in srgb, var(--dd-loading-color) 92%, transparent)
      color-mix(in srgb, var(--dd-loading-color) 92%, transparent) transparent
      transparent;
    border-radius: 999px;
    transform-origin: center;
  }

  .loop--left {
    left: 0;
    transform: translateY(-50%) rotate(45deg);
    animation: dd-loading-infinity-left 1.15s ease-in-out infinite;
  }

  .loop--right {
    right: 0;
    transform: translateY(-50%) rotate(-45deg);
    animation: dd-loading-infinity-right 1.15s ease-in-out infinite;
  }
}

@keyframes dd-loading-spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes dd-loading-dot-pulse {
  0%,
  80%,
  100% {
    opacity: 0.32;
    transform: translateY(0) scale(0.78);
  }
  40% {
    opacity: 1;
    transform: translateY(-1px) scale(1);
  }
}

@keyframes dd-loading-infinity-left {
  0% {
    transform: translateY(-50%) rotate(45deg) scale(0.92);
  }
  50% {
    transform: translateY(-50%) rotate(225deg) scale(1);
  }
  100% {
    transform: translateY(-50%) rotate(405deg) scale(0.92);
  }
}

@keyframes dd-loading-infinity-right {
  0% {
    transform: translateY(-50%) rotate(-45deg) scale(1);
  }
  50% {
    transform: translateY(-50%) rotate(-225deg) scale(0.92);
  }
  100% {
    transform: translateY(-50%) rotate(-405deg) scale(1);
  }
}
</style>
