/** 浏览器媒体错误的人话原因；格式/编码不支持属永久失败，重下同一份文件不会好。 */
export interface MediaErrorPayload {
  reason: string
  permanent: boolean
}

/** HTMLMediaElement 的 MediaError code 映射。 */
export function mediaErrorInfo(el: HTMLMediaElement | null): MediaErrorPayload {
  switch (el?.error?.code) {
    case 1:
      return { reason: '播放被中断', permanent: false }
    case 2:
      return { reason: '网络错误', permanent: false }
    case 3:
      return { reason: '解码失败', permanent: false }
    case 4:
      return { reason: '格式不支持', permanent: true }
    default:
      return { reason: '播放器报错', permanent: false }
  }
}

const HLS_LABELS: Record<string, string> = {
  networkError: '网络错误',
  mediaError: '解码失败',
  keyLoadError: '密钥加载失败',
  manifestLoadError: '列表加载失败',
  manifestLoadTimeOut: '列表加载超时',
  manifestParsingError: '列表解析失败',
  levelLoadError: '码率列表加载失败',
  levelLoadTimeOut: '码率列表加载超时',
  levelParsingError: '码率列表解析失败',
  fragLoadError: '分片加载失败',
  fragLoadTimeOut: '分片加载超时',
  fragParsingError: '分片解析失败',
  bufferStalledError: '播放缓冲中断',
  bufferSeekOverHole: '跳转缓冲中断',
  bufferAddCodecError: '编码不支持',
}

/** hls.js 的 fatal 错误：把枚举 details 换成人话，4xx/编码不支持不提供重下。 */
export function hlsErrorInfo(data: {
  details?: string
  response?: { code?: number }
}): MediaErrorPayload {
  const code = String(data?.details ?? '')
  const label = HLS_LABELS[code]
  const status = Number(data?.response?.code ?? 0)
  return {
    reason: label ? `HLS ${label}` : 'HLS 播放失败',
    permanent: (status >= 400 && status < 500) || code === 'bufferAddCodecError',
  }
}
