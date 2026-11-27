/**
 * 常亮控制器（#126）——包一层 Screen Wake Lock，逻辑可注入、可单测。
 *
 * 规则：运行期申请；页面隐藏时系统会释放，可见时重申请；停止/关闭/离开书时释放；
 * 浏览器拒绝或没有该 API 时只提示一次「无法保持常亮」，不影响自动翻页。
 */

export interface WakeLockSentinelLike {
  released: boolean
  release(): Promise<void>
}

export interface KeepAwakeOptions {
  /** 申请锁；不支持时抛错或返回 null */
  request: () => Promise<WakeLockSentinelLike | null | undefined>
  /** 只会在整个实例生命周期内调用一次 */
  onNotice?: (message: string) => void
}

export const WAKE_LOCK_UNAVAILABLE_MESSAGE = '无法保持常亮'

const safeRelease = async (sentinel: WakeLockSentinelLike): Promise<void> => {
  if (sentinel.released) return
  try {
    await sentinel.release()
  } catch {
    // 系统已回收时 release 可能抛错，忽略
  }
}

export class KeepAwake {
  private readonly requestLock: KeepAwakeOptions['request']
  private readonly onNotice?: (message: string) => void
  private sentinel: WakeLockSentinelLike | null = null
  private pending: Promise<void> | null = null
  private desired = false
  private unavailable = false
  private noticed = false

  constructor(options: KeepAwakeOptions) {
    this.requestLock = options.request
    this.onNotice = options.onNotice
  }

  get active(): boolean {
    return this.desired && this.sentinel !== null && !this.sentinel.released
  }

  async acquire(): Promise<void> {
    this.desired = true
    if (this.unavailable) return
    if (this.sentinel && !this.sentinel.released) return
    if (this.pending) return this.pending
    this.pending = this.requestOnce()
    try {
      await this.pending
    } finally {
      this.pending = null
    }
  }

  async release(): Promise<void> {
    this.desired = false
    this.unavailable = false
    const sentinel = this.sentinel
    this.sentinel = null
    if (sentinel) await safeRelease(sentinel)
  }

  /** 页面可见性变化；可见时按需重申请。 */
  async visibilityChanged(visible: boolean): Promise<void> {
    if (!visible) {
      const sentinel = this.sentinel
      this.sentinel = null
      if (sentinel) await safeRelease(sentinel)
      return
    }
    if (this.desired) await this.acquire()
  }

  private async requestOnce(): Promise<void> {
    try {
      const sentinel = await this.requestLock()
      if (!sentinel) {
        this.markUnavailable()
        return
      }
      if (!this.desired) {
        await safeRelease(sentinel)
        return
      }
      this.sentinel = sentinel
    } catch {
      this.sentinel = null
      this.markUnavailable()
    }
  }

  private markUnavailable(): void {
    this.unavailable = true
    if (this.noticed) return
    this.noticed = true
    try {
      this.onNotice?.(WAKE_LOCK_UNAVAILABLE_MESSAGE)
    } catch {
      // 提示失败不影响阅读
    }
  }
}