// 媒体地址与响应类型只在一处判定；下载、播放和服务端代理共用同一套 HLS/直链规则。
const HLS_CONTENT_TYPE = /^(?:application|audio)\/(?:vnd\.apple\.mpegurl|x-mpegurl|mpegurl)$/i
const DIRECT_CONTENT_TYPE = /^(?:audio|video)\//i
const DIRECT_EXTENSION = /\.(?:mp4|m4v|webm|mov|mkv|mp3|m4a|aac|ogg|oga|opus|wav|flac|ts|m2ts|mts)$/i

export function isHlsUrl(value) {
  try { return /\.m3u8$/i.test(new URL(value).pathname) } catch { return false }
}

export function mediaUrlKind(value) {
  if (isHlsUrl(value)) return 'hls'
  try {
    if (DIRECT_EXTENSION.test(new URL(value).pathname)) return 'direct'
  } catch {}
  return 'unknown'
}

export function mediaKindFromContentType(value) {
  const type = String(value ?? '').split(';')[0].trim().toLowerCase()
  if (HLS_CONTENT_TYPE.test(type)) return 'hls'
  if (DIRECT_CONTENT_TYPE.test(type)) return 'direct'
  return null
}
