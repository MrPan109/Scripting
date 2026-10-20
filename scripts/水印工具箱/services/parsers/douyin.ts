import { fetch } from "scripting"
import type { ResourceItem } from "../../types/resource"
import { sanitizeFileName } from "../../utils/fileName"
import { douyinVideoVariants } from "../../utils/sourceVideoVariants"
import type { SiteParser, SiteParseContext, SiteParseResult } from "./types"

const MOBILE_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
const VIDEO_ADDRESS_KEYS = ["play_addr_h264", "play_addr_265", "play_addr", "download_addr", "playAddr", "downloadAddr"]
const IMAGE_ADDRESS_KEYS = ["url_list", "urlList", "download_url_list", "downloadUrlList", "watermark_free_download_url_list"]

type VideoMetadata = Pick<ResourceItem, "width" | "height" | "byteSize" | "durationSeconds">

type VideoVariant = {
  qualityGroup?: string
  urls: string[]
  metadata: VideoMetadata
  quality?: string
  format?: string
}

type LivePhotoCandidate = {
  stillUrls: string[]
  videoUrls: string[]
  quality?: string
  durationSeconds?: number
}

type DouyinCollected = {
  videoVariants: VideoVariant[]
  title: string
  videoUrls: string[]
  videoMetadata: Map<string, VideoMetadata>
  imageUrls: string[]
  coverUrls: string[]
  livePhotos: LivePhotoCandidate[]
  imageEntries: Set<object>
}

function createCollected(): DouyinCollected {
  return { title: "", videoVariants: [], videoUrls: [], videoMetadata: new Map(), imageUrls: [], coverUrls: [], livePhotos: [], imageEntries: new Set() }
}

function addUnique(target: string[], value: unknown) {
  if (typeof value !== "string") return
  const url = value.replace(/\\u002F/gi, "/").replace(/\\\//g, "/").replace(/&amp;/g, "&").trim()
  if (!/^https?:\/\//i.test(url) || target.includes(url)) return
  // 排除 CSS/JS/字体等非媒体资源
  if (/\.(css|js|woff2?|ttf|svg|ico|m3u8)(?:\?|#|$)/i.test(url)) return
  if (/\/static\/(?:css|js)\//i.test(url)) return
  target.push(url)
}

function collectAddress(value: unknown, target: string[]) {
  if (typeof value === "string") {
    addUnique(target, value)
    return
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectAddress(item, target))
    return
  }
  if (!value || typeof value !== "object") return

  const record = value as Record<string, unknown>
  for (const key of [...IMAGE_ADDRESS_KEYS, "uri", "url"]) {
    if (record[key] !== undefined) collectAddress(record[key], target)
  }
}

function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function saveVideoMetadata(result: DouyinCollected, url: string, metadata: VideoMetadata) {
  const current = result.videoMetadata.get(url) ?? {}
  // 同一地址重复出现时只补齐有效字段，不用缺失值覆盖已有信息。
  for (const key of ["width", "height", "byteSize", "durationSeconds"] as const) {
    const value = positiveNumber(metadata[key])
    if (current[key] === undefined && value !== undefined) current[key] = value
  }
  result.videoMetadata.set(url, current)
}

function collectVideoAddress(value: unknown, result: DouyinCollected, video: Record<string, unknown>, durationMs: unknown = video.duration, addressKey = "", qualityGroup?: string) {
  const urls: string[] = []
  collectAddress(value, urls)
  const address = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  const duration = positiveNumber(durationMs)
  const metadata: VideoMetadata = {
    width: positiveNumber(address.width) ?? positiveNumber(video.width),
    height: positiveNumber(address.height) ?? positiveNumber(video.height),
    // 文件大小必须属于当前地址，不能借用其他码率或下载地址的大小。
    byteSize: positiveNumber(address.data_size) ?? positiveNumber(address.dataSize),
    // 抖音结构化数据的 duration 单位为毫秒。
    durationSeconds: duration === undefined ? undefined : duration / 1000,
  }
  if (urls.length === 0) return
  const shared = douyinVideoVariants({
    ...video, bit_rate: positiveNumber(video.bit_rate), bitRate: positiveNumber(video.bitRate),
    duration: durationMs,
    [addressKey]: { ...address, url_list: urls },
  }).find(item => urls.includes(item.url))
  const codec = video.is_h265 === 1 || video.is_h265 === true || /265/.test(addressKey) ? "H.265"
    : /h264/.test(addressKey) ? "H.264" : undefined
  const quality = shared?.quality ?? (metadata.width && metadata.height
    ? `${metadata.width} × ${metadata.height}` : "来源画质（分辨率未知）")
  // url_list 是同一来源流的线路，不是画质列表。只依据地址交集归并，
  // 不按 video_id/尺寸/uri 合并：这些字段可能被不同码率、编码共用。
  const matches = result.videoVariants.filter(variant => variant.urls.some(url => urls.includes(url)))
  const variant: VideoVariant = matches[0] ?? { urls: [], metadata: {}, quality, format: codec, qualityGroup }
  for (const other of matches.slice(1)) {
    other.urls.forEach(url => addUnique(variant.urls, url))
    Object.assign(variant.metadata, Object.fromEntries(Object.entries(other.metadata).filter(([, value]) => value !== undefined)))
    result.videoVariants.splice(result.videoVariants.indexOf(other), 1)
  }
  urls.forEach(url => addUnique(variant.urls, url))
  for (const key of ["width", "height", "byteSize", "durationSeconds"] as const) {
    if (variant.metadata[key] === undefined && metadata[key] !== undefined) variant.metadata[key] = metadata[key]
  }
  if (quality) variant.quality = quality
  if (codec) variant.format = codec
  if (matches.length === 0) result.videoVariants.push(variant)
  for (const url of urls) {
    addUnique(result.videoUrls, url)
    saveVideoMetadata(result, url, metadata)
  }
}

function imageStillUrls(record: Record<string, unknown>): string[] {
  const urls: string[] = []
  for (const key of ["display_image", "displayImage", "origin_image", "originImage", "download_url", "downloadUrl", ...IMAGE_ADDRESS_KEYS, "uri", "url"]) {
    if (record[key] !== undefined) collectAddress(record[key], urls)
  }
  return urls
}

/** 图文中实况图片的动态片段；普通视频对象不在这里处理。 */
function liveMotionObject(record: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of ["video", "live_photo", "livePhoto", "dynamic_image", "dynamicImage", "motion"]) {
    const value = record[key]
    if (Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === "object") {
      return value[0] as Record<string, unknown>
    }
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  }
  if (record.play_addr || record.playAddr) return record
  return undefined
}

function liveMotionInfo(motion: Record<string, unknown>, stillRecord: Record<string, unknown>) {
  const urls: string[] = []
  for (const key of VIDEO_ADDRESS_KEYS) {
    if (motion[key] !== undefined) collectAddress(motion[key], urls)
  }
  if (Array.isArray(motion.bit_rate) || Array.isArray(motion.bitRate)) {
    const rates = (motion.bit_rate ?? motion.bitRate) as unknown[]
    for (const rate of rates) {
      if (!rate || typeof rate !== "object") continue
      for (const key of VIDEO_ADDRESS_KEYS) {
        const value = (rate as Record<string, unknown>)[key]
        if (value !== undefined) collectAddress(value, urls)
      }
    }
  }
  if (urls.length === 0) collectAddress(motion.url_list ?? motion.urlList ?? motion.url, urls)

  let quality: string | undefined
  try {
    const variants = douyinVideoVariants(motion)
    if (variants.length > 0) {
      for (const url of [variants[0].url, ...(variants[0].alternateUrls ?? [])]) addUnique(urls, url)
      quality = variants[0].quality
    }
  } catch {}

  const duration = positiveNumber(motion.duration ?? stillRecord.duration)
  return { urls, quality, durationSeconds: duration === undefined ? undefined : duration / 1000 }
}

function collectImageEntry(item: unknown, result: DouyinCollected) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return
  const record = item as Record<string, unknown>
  if (result.imageEntries.has(record)) return
  result.imageEntries.add(record)

  const stills = imageStillUrls(record)
  for (const url of stills) addUnique(result.imageUrls, url)

  const motion = liveMotionObject(record)
  if (!motion || stills.length === 0) return
  const info = liveMotionInfo(motion, record)
  if (info.urls.length === 0) return
  result.livePhotos.push({
    stillUrls: pickLargestImageVariants(stills),
    videoUrls: info.urls,
    quality: info.quality,
    durationSeconds: info.durationSeconds,
  })
}

function collectImageEntries(value: unknown, result: DouyinCollected) {
  if (!Array.isArray(value)) return
  for (const item of value) collectImageEntry(item, result)
}

function collectData(root: unknown, result: DouyinCollected) {
  const visited = new Set<object>()

  function walk(value: unknown, depth: number, inheritedGroup?: string) {
    if (depth > 18 || !value || typeof value !== "object") return
    const objectValue = value as object
    if (visited.has(objectValue)) return
    visited.add(objectValue)

    if (Array.isArray(value)) {
      value.forEach(item => walk(item, depth + 1))
      return
    }

    const record = value as Record<string, unknown>
    if (result.imageEntries.has(record)) return
    // 图片条目内部的 video 是实况动态，不是独立作品视频。
    if (liveMotionObject(record) && imageStillUrls(record).length > 0) {
      collectImageEntry(record, result)
      return
    }

    if (!result.title) {
      for (const key of ["desc", "description", "title", "share_title", "shareTitle"]) {
        if (typeof record[key] === "string" && record[key]!.trim()) {
          result.title = String(record[key]).trim()
          break
        }
      }
    }

    const hasVideoData = VIDEO_ADDRESS_KEYS.some(key => record[key] !== undefined) || Array.isArray(record.bit_rate) || Array.isArray(record.bitRate)
    const qualityGroup = inheritedGroup ?? (hasVideoData ? `douyin-video-${result.videoVariants.length + 1}` : undefined)
    const hasPlayback = VIDEO_ADDRESS_KEYS.some(key => !/download/i.test(key) && record[key] !== undefined)
    for (const key of VIDEO_ADDRESS_KEYS) {
      // 有来源播放流时，download_addr 不作为另一档画质（通常是水印下载版）。
      if (hasPlayback && /download/i.test(key)) continue
      if (record[key] !== undefined) collectVideoAddress(record[key], result, record, record.duration, key, qualityGroup)
    }
    const bitrates = record.bit_rate ?? record.bitRate
    if (Array.isArray(bitrates)) {
      for (const bitrate of bitrates) {
        if (!bitrate || typeof bitrate !== "object") continue
        const item = bitrate as Record<string, unknown>
        for (const key of VIDEO_ADDRESS_KEYS) {
          if (item[key] !== undefined) collectVideoAddress(item[key], result, item, item.duration ?? record.duration, key, qualityGroup)
        }
      }
    }

    collectImageEntries(record.images, result)
    const imagePost = record.image_post_info || record.imagePostInfo
    if (imagePost && typeof imagePost === "object") {
      collectImageEntries((imagePost as Record<string, unknown>).images, result)
    }

    for (const key of ["cover", "origin_cover", "dynamic_cover", "poster_url", "video_cover"]) {
      if (record[key] !== undefined) collectAddress(record[key], result.coverUrls)
    }

    // bit_rate 已在父视频上下文处理，不再递归丢失其分组和时长。
    Object.entries(record).forEach(([key, item]) => {
      if (key !== "bit_rate" && key !== "bitRate") walk(item, depth + 1)
    })
  }

  walk(root, 0)
}

function decodeEntities(value: string): string {
  return value.replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
}

function extractCanonicalUrl(html: string): string | undefined {
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1]
    || html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i)?.[1]
  if (!canonical) return undefined

  const decoded = decodeEntities(canonical).trim()
  return /^https?:\/\/(?:www\.)?douyin\.com\/(?:video|note)\/\d+/i.test(decoded)
    ? decoded
    : undefined
}

function parseJsonText(text: string): unknown | null {
  const candidates = [text.trim(), decodeEntities(text.trim())]
  try {
    candidates.push(decodeURIComponent(text.trim()))
  } catch {}

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {}
  }
  return null
}

function collectStaticData(html: string, result: DouyinCollected) {
  const scriptRegex = /<script[^>]*(?:id=["'](?:RENDER_DATA|__UNIVERSAL_DATA_FOR_REHYDRATION__)["']|type=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null
  while ((match = scriptRegex.exec(html)) !== null) {
    const parsed = parseJsonText(match[1])
    if (parsed) collectData(parsed, result)
  }

  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]
  if (!result.title && title) result.title = decodeEntities(title).trim()
}

async function waitForWebViewLoad(webView: WebViewController): Promise<void> {
  // 等待首屏加载，最多 8 秒
  try {
    await Promise.race([
      webView.waitForLoad?.()?.then(() => true)?.catch(() => false) ?? Promise.resolve(false),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 8000)),
    ])
  } catch {}
}

// 在 WebView 内调用抖音 Web API 获取作品详情，利用 WebView 的 cookies 和 referer 上下文
async function fetchAwemeDetailInWebView(webView: WebViewController, awemeId: string): Promise<string | null> {
  const escapedId = JSON.stringify(awemeId)
  return webView.evaluateJavaScript<string | null>(`
    return (async () => {
      const awemeId = ${escapedId}
      const timeout = (ms) => new Promise((resolve) => setTimeout(() => resolve(null), ms))
      const fetchDetail = async () => {
        const params = new URLSearchParams({
          device_platform: 'webapp', channel: 'channel_pc_web',
          update_version_code: '170400', pc_client_type: '1',
          version_code: '290100', version_name: '29.1.0',
          cookie_enabled: 'true',
          screen_width: String(window.screen?.width || 390),
          screen_height: String(window.screen?.height || 844),
          browser_language: navigator.language || 'zh-CN',
          browser_platform: navigator.platform || 'iPhone',
          browser_name: 'Safari', browser_version: '18.0',
          browser_online: String(navigator.onLine),
          engine_name: 'WebKit', engine_version: '605.1.15',
          os_name: 'iOS', os_version: '18',
          cpu_core_num: String(navigator.hardwareConcurrency || 8),
          device_memory: '8', platform: 'PC',
          downlink: '10', effective_type: '4g', round_trip_time: '200',
          support_h265: '1', support_dash: '1', uifid: '',
          aweme_id: awemeId, aid: '6383',
        })
        for (const endpoint of ['/aweme/v1/web/aweme/detail/', 'https://www.douyin.com/aweme/v1/web/aweme/detail/']) {
          try {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 1800)
            const response = await fetch(endpoint + '?' + params.toString(), {
              credentials: 'include', signal: controller.signal,
              headers: { accept: 'application/json, text/plain, */*' },
            })
            clearTimeout(timer)
            if (!response.ok) continue
            const json = await response.json()
            if (json?.aweme_detail) return JSON.stringify(json)
          } catch (e) {}
        }
        return null
      }
      return await Promise.race([fetchDetail(), timeout(4500)])
    })()
  `)
}

function extractAwemeId(url: string): string | null {
  return url.match(/\/(?:share\/)?(?:video|note|gallery|slides)\/(\d{15,20})/)?.[1]
    || url.match(/[?&](?:modal_id|aweme_id|item_id)=(\d{15,20})/)?.[1]
    || null
}

/** WebView evaluateJavaScript<string>：返回 JSON 数组，不执行页面内嵌脚本文本。 */
export const DOUYIN_STRUCTURED_DATA_SCRIPT = `return (() => {
  const roots = []
  for (const key of ['_ROUTER_DATA', 'videoInfoRes', '__UNIVERSAL_DATA_FOR_REHYDRATION__']) {
    try { if (window[key] && typeof window[key] === 'object') roots.push(window[key]) } catch (_) {}
  }
  for (const node of document.querySelectorAll('script#RENDER_DATA, script#__UNIVERSAL_DATA_FOR_REHYDRATION__, script[type="application/json"]')) {
    const text = node.textContent || ''
    try { roots.push(JSON.parse(text)); continue } catch (_) {}
    try { roots.push(JSON.parse(decodeURIComponent(text))) } catch (_) {}
  }
  try { return JSON.stringify(roots) } catch (_) { return '[]' }
})()`

/** 纯转换接口，供主入口复用；root 可为上面脚本 JSON.parse 后的数组。 */
export function resourcesFromDouyinData(root: unknown, context: SiteParseContext): ResourceItem[] {
  const collected = createCollected()
  collectData(root, collected)
  return makeResources(context, collected)
}

async function collectWebViewData(url: string, result: DouyinCollected) {
  const webView = new WebViewController({ ephemeral: true })
  try {
    webView.setCustomUserAgent(MOBILE_USER_AGENT)
    // 抖音会持续请求资源，loadURL 可能不结束；使用下面的有界等待。
    void webView.loadURL(url).catch(() => false)

    // 等待首屏加载稳定
    await waitForWebViewLoad(webView)
    await new Promise<void>(resolve => setTimeout(resolve, 2500))

    // 激活视频节点触发数据加载
    await webView.evaluateJavaScript(`
      (async () => {
        const video = document.querySelector('video')
        if (video) {
          try { video.muted = true; await video.play() } catch (e) {}
        }
      })()
    `)
    await new Promise<void>(resolve => setTimeout(resolve, 4000))

    // 读取完整 JSON，避免旧的 script 文本截断丢掉后面的码率版本。
    try {
      const json = await webView.evaluateJavaScript<string>(DOUYIN_STRUCTURED_DATA_SCRIPT)
      collectData(JSON.parse(json), result)
    } catch {}

    // 读取页面内嵌数据和全局变量
    const snapshot = await webView.evaluateJavaScript<any>(`
      const mediaEntries = performance.getEntriesByType('resource')
        .map((item) => item.name)
        .filter((name) => ['video','playwm','/play/','mp4','douyinvod','tos-cn','douyinpic'].some((t) => name.includes(t)))
      const scripts = Array.from(document.scripts)
        .map((s) => s.textContent || '')
        .filter((text) => ['aweme_detail','play_addr','bit_rate','playwm','video_id','_ROUTER_DATA','videoInfoRes','image_post_info','images'].some((t) => text.includes(t)))
        .slice(0, 8).map((text) => text.slice(0, 12000))
      let routerDataJSON = null, videoInfoResJSON = null
      try {
        if (typeof window._ROUTER_DATA !== 'undefined') {
          routerDataJSON = JSON.stringify(window._ROUTER_DATA)
          const loaderValues = Object.values(window._ROUTER_DATA?.loaderData || {})
          const matched = loaderValues.find((item) => item?.videoInfoRes)?.videoInfoRes
          if (matched) videoInfoResJSON = JSON.stringify(matched)
        }
      } catch (e) {}
      try {
        if (!videoInfoResJSON && typeof window.videoInfoRes !== 'undefined') {
          videoInfoResJSON = JSON.stringify(window.videoInfoRes)
        }
      } catch (e) {}
      const videos = Array.from(document.querySelectorAll('video')).map(item => ({
        src: item.currentSrc || item.src || '',
        poster: item.poster || '',
        width: item.videoWidth,
        height: item.videoHeight,
        durationSeconds: Number.isFinite(item.duration) ? item.duration : null
      }))
      const images = Array.from(document.images).map(img => img.currentSrc || img.src).filter(Boolean).slice(0, 80)
      const canonical = document.querySelector('link[rel="canonical"]')?.href || null
      return {
        title: document.title || '',
        videos, images, canonical,
        routerDataJSON, videoInfoResJSON,
        resourceHints: scripts,
        performanceMedia: mediaEntries,
      }
    `)

    if (!snapshot || typeof snapshot !== "object") return
    if (!result.title && typeof snapshot.title === "string") result.title = snapshot.title.trim()

    // 视频标签 src
    if (Array.isArray(snapshot.videos)) {
      for (const item of snapshot.videos) {
        const urls: string[] = []
        addUnique(urls, item?.src)
        for (const videoUrl of urls) {
          addUnique(result.videoUrls, videoUrl)
          saveVideoMetadata(result, videoUrl, {
            width: positiveNumber(item?.width),
            height: positiveNumber(item?.height),
            durationSeconds: positiveNumber(item?.durationSeconds),
          })
        }
        addUnique(result.coverUrls, item?.poster)
      }
    }

    // performance 资源请求中的媒体 URL（排除 CSS/JS）
    if (Array.isArray(snapshot.performanceMedia)) {
      for (const url of snapshot.performanceMedia) {
        if (typeof url !== "string") continue
        // 只保留真正的视频流 URL，排除 CSS/JS/字体等
        if (/\/(?:playwm|play)\//i.test(url) || /douyinvod|aweme\.snssdk\.com\/aweme\/v1\/play/i.test(url)) {
          addUnique(result.videoUrls, url)
        }
      }
    }

    // DOM 图片
    if (Array.isArray(snapshot.images)) {
      for (const url of snapshot.images) {
        if (typeof url === "string" && /douyinpic|tos-cn|p3-sign/i.test(url)) {
          addUnique(result.imageUrls, url)
        }
      }
    }

    // 解析 _ROUTER_DATA 和 videoInfoRes 中的结构化数据
    for (const jsonStr of [snapshot.routerDataJSON, snapshot.videoInfoResJSON]) {
      if (typeof jsonStr === "string" && jsonStr) {
        try {
          collectData(JSON.parse(jsonStr), result)
        } catch {}
      }
    }

    // script 标签中的内嵌数据
    if (Array.isArray(snapshot.resourceHints)) {
      for (const hint of snapshot.resourceHints) {
        if (typeof hint !== "string") continue
        try {
          collectData(JSON.parse(hint), result)
        } catch {}
      }
    }

    // 无资源时，或已拿到图片但还没识别到实况时，读取作品详情补全动态片段。
    if ((result.videoUrls.length === 0 && result.imageUrls.length === 0)
      || (result.imageUrls.length > 0 && result.livePhotos.length === 0)) {
      const awemeId = extractAwemeId(snapshot.canonical || url)
      if (awemeId) {
        const apiJSON = await fetchAwemeDetailInWebView(webView, awemeId)
        if (apiJSON) {
          try { collectData(JSON.parse(apiJSON), result) } catch {}
        }
      }
    }
  } finally {
    webView.dispose()
  }
}

function preferPlayableVideo(urls: string[]): string[] {
  return [...urls].sort((a, b) => {
    const score = (value: string) => {
      // 真正的播放 API URL 最高优先
      if (/aweme\/v1\/play/i.test(value)) return 5
      if (/\/play\//i.test(value)) return 4
      if (/\/playwm\//i.test(value)) return 3
      // CDN 视频流
      if (/douyinvod/i.test(value)) return 2
      // 其他
      return 0
    }
    return score(b) - score(a)
  })
}

/** 解码 URL 参数（失败时原样返回）。 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * 抖音页面上同一个 `video_id` 参数既可能是真视频，也可能是背景音乐：
 * 图片作品的 BGM 就是用 `playwm/?video_id=<音乐 mp3 地址>` 这种方式播放的。
 * 这里按真实用途归类，避免把音乐当成视频导出（扩展名会变成 .mp3）。
 */
function classifyCollectedURL(url: string): ResourceItem["type"] {
  const lower = url.toLowerCase()
  const playMatch = url.match(/\/play(?:wm)?\/\?[^#]*\bvideo_id=([^&]+)/i)
  if (playMatch) {
    const id = safeDecode(playMatch[1])
    if (/^https?:\/\//i.test(id) || /\.(?:mp3|m4a|aac|wav|flac|ogg)(?:[?#]|$)/i.test(id)) return "audio"
    return "video"
  }
  if (/\.(?:mp3|m4a|aac|wav|flac|ogg)(?:[?#]|$)/i.test(lower)) return "audio"
  if (/ies-music|\/music\//i.test(lower)) return "audio"
  return "video"
}

/**
 * playwm 包着音乐地址时，真正的音乐文件是里面那个 URL；
 * 用它作为地址可以让「包装过的」和「直链的」同一首 BGM 合并成一条。
 */
function unwrapAudioURL(url: string): string {
  const match = url.match(/\/play(?:wm)?\/\?[^#]*\bvideo_id=([^&]+)/i)
  if (!match) return url
  const inner = safeDecode(match[1])
  return /^https?:\/\//i.test(inner) ? inner : url
}

/**
 * 判断地址是否已是抖音的无水印源：官方 `play` 端点、图片原图（非 `playwm`、
 * 非 watermark 模板）都算。`download_addr`、`playwm` 这类是带水印的。
 */
function isWatermarkFreeDouyinURL(url: string): boolean {
  if (/\/aweme\/v1\/play\//i.test(url)) return true
  if (/playwm/i.test(url)) return false
  if (/watermark|_wm[.:/]/i.test(url)) return false
  if (/(?:douyinpic|douyinstatic|tos-cn)/i.test(url)) return true
  return false
}

/** 按地址给出正确的扩展名：抖音图集常是 webp，硬写成 .jpg 会出现扩展名与内容不符。 */
function extensionFor(url: string, fallback: string): string {
  try {
    const path = new URL(url).pathname
    const match = path.match(/\.(jpe?g|png|webp|gif|heic|avif|mp4|mov|m4v|mp3|m4a|aac|wav)$/i)
    return match ? match[1].toLowerCase() : fallback
  } catch {
    return fallback
  }
}

/**
 * 从 `~tplv-dy-lqen-new:2278:1708:q80` 这类模板 / `sh=640_479` 参数里读出像素尺寸，
 * 算不出来就返回 -1（未知）。
 */
function imageVariantArea(url: string): number {
  const template = url.match(/~tplv-[^:/?#]*:(\d+):(\d+)/i)
  if (template) return Number(template[1]) * Number(template[2])
  const sh = url.match(/[?&]sh=(\d+)_(\d+)/)
  if (sh) return Number(sh[1]) * Number(sh[2])
  return -1
}

/**
 * 同一张图在抖音会同时给出多个尺寸变体（缩略图 + 原图），
 * 它们的对象路径一致、只有 `~tplv-` 模板不同。这里只保留最大的那个，
 * 避免列表里全是同一张图的多个尺寸。
 */
function pickLargestImageVariants(urls: string[]): string[] {
  const groups = new Map<string, { url: string; area: number }>()
  const order: string[] = []
  for (const url of urls) {
    let key = url
    try {
      // 对象路径相同的就是同一张图；`~` 后面（~tplv-xxx:W:H 、~q80.webp 等）
      // 只是抖音的图片处理模板，尺寸差异，不是不同的图。
      key = new URL(url).pathname.split("~")[0]
    } catch {}
    const area = imageVariantArea(url)
    const current = groups.get(key)
    if (!current) {
      groups.set(key, { url, area })
      order.push(key)
      continue
    }
    if (area > current.area) groups.set(key, { url, area })
  }
  return order.map(key => groups.get(key)!.url)
}

function makeResources(context: SiteParseContext, collected: DouyinCollected): ResourceItem[] {
  const headers = { "User-Agent": MOBILE_USER_AGENT, Referer: context.url }
  const title = sanitizeFileName(collected.title.replace(/[-_]?抖音.*$/i, "").trim() || "douyin", "douyin")
  const resources: ResourceItem[] = []
  const seen = new Set<string>()

  const push = (type: ResourceItem["type"], url: string, name: string, extra: Partial<ResourceItem> = {}) => {
    const key = `${type}:${url}`
    if (seen.has(key)) return
    seen.add(key)
    const watermarkFree = isWatermarkFreeDouyinURL(url)
    resources.push({
      type,
      url,
      name,
      source: "douyin",
      headers,
      ...(watermarkFree ? { watermarkFree: true, watermarkFreeUrl: url, quality: "无水印" } : {}),
      ...extra,
    })
  }

  // 结构化地址组优先；同组线路放备用列表，不把 DOM/performance 的
  // 同一视频重定向地址再列为画质，也不把各版本改成统一的 play URL。
  let videoIndex = 0
  const groupedUrls = new Set<string>()
  for (const variant of collected.videoVariants) {
    const urls = variant.urls.filter(url => classifyCollectedURL(url) === "video")
    if (urls.length === 0) continue
    urls.forEach(url => groupedUrls.add(url))
    const url = urls[0]
    videoIndex += 1
    push("video", url, `${title}_${videoIndex}.${extensionFor(url, "mp4")}`, {
      ...variant.metadata,
      preserveSourceVariant: true,
      qualityGroup: variant.qualityGroup,
      quality: variant.quality,
      format: variant.format,
      alternateUrls: urls.slice(1),
    })
  }
  const hasStructuredVideo = videoIndex > 0
  // 视频与背景音乐分开：同一个 playwm 端点两种都可能出现
  const ordered = preferPlayableVideo(collected.videoUrls)
  let audioIndex = 0
  for (const url of ordered) {
    if (classifyCollectedURL(url) === "audio") {
      audioIndex += 1
      const audioURL = unwrapAudioURL(url)
      push("audio", audioURL, `${title}${audioIndex > 1 ? `_bgm_${audioIndex}` : "_bgm"}.${extensionFor(audioURL, "mp3")}`, {
        quality: audioIndex === 1 ? "背景音乐" : undefined,
      })
    } else {
      if (groupedUrls.has(url) || hasStructuredVideo) continue
      push("video", url, `${title}${videoIndex > 0 ? `_${videoIndex + 1}` : ""}.${extensionFor(url, "mp4")}`, {
        ...collected.videoMetadata.get(url),
        quality: "页面播放来源（画质未知）",
      })
      videoIndex += 1
    }
  }

  const imageUrls = pickLargestImageVariants(collected.imageUrls)
  const stillKey = (url: string) => {
    try { return new URL(url).pathname.split("~")[0] } catch { return url }
  }
  // 同一静图可能在多个结构字段里重复出现；只保留一组动态片段，避免出现多个实况条目。
  const livePhotos = new Map<string, LivePhotoCandidate>()
  for (const candidate of collected.livePhotos) {
    const still = pickLargestImageVariants(candidate.stillUrls)[0]
    if (!still) continue
    const key = stillKey(still)
    const existing = livePhotos.get(key)
    if (!existing) {
      livePhotos.set(key, { ...candidate, stillUrls: [still] })
      if (!imageUrls.includes(still)) imageUrls.push(still)
      continue
    }
    candidate.videoUrls.forEach(url => addUnique(existing.videoUrls, url))
    if (!existing.quality && candidate.quality) existing.quality = candidate.quality
    if (existing.durationSeconds === undefined && candidate.durationSeconds !== undefined) existing.durationSeconds = candidate.durationSeconds
  }

  imageUrls.forEach((url, index) => {
    const live = livePhotos.get(stillKey(url))
    if (!live) {
      push("image", url, `${title}_${index + 1}.${extensionFor(url, "jpg")}`)
      return
    }
    livePhotos.delete(stillKey(url))
    push("image", url, `${title}_${index + 1}.${extensionFor(url, "jpg")}`, {
      livePhotoUrl: live.videoUrls[0],
      livePhotoAlternateUrls: live.videoUrls.slice(1),
      livePhotoDurationSeconds: live.durationSeconds,
      quality: live.quality,
    })
  })

  pickLargestImageVariants(collected.coverUrls).forEach((url, index) => {
    if (imageUrls.includes(url)) return
    push("image", url, `${title}_cover${index > 0 ? `_${index + 1}` : ""}.${extensionFor(url, "jpg")}`, { likelyThumbnail: true })
  })

  return resources
}

async function fetchCanonicalPage(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: { "User-Agent": MOBILE_USER_AGENT } })
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

async function parseDouyin(context: SiteParseContext): Promise<SiteParseResult> {
  const collected = createCollected()
  const pageUrl = extractCanonicalUrl(context.html)
  const shouldFollowPage = pageUrl && pageUrl.split("#")[0] !== context.url.split("#")[0]
  collectStaticData(context.html, collected)

  // 分享页提取到 canonical 但当前 HTML 无资源时，跟随 canonical 重新解析
  if (shouldFollowPage && pageUrl) {
    const canonicalHtml = await fetchCanonicalPage(pageUrl)
    if (canonicalHtml) collectStaticData(canonicalHtml, collected)
  }

  // 无资源时用 WebView 兜底；图文页即使已有静态图，也要读取详情确认是否带实况动态。
  const isNotePage = /\/(?:share\/)?(?:note|gallery|slides)\//i.test(pageUrl || context.url)
  if ((collected.videoUrls.length === 0 && collected.imageUrls.length === 0)
    || (isNotePage && collected.imageUrls.length > 0 && collected.livePhotos.length === 0)) {
    await collectWebViewData(shouldFollowPage && pageUrl ? pageUrl : context.url, collected)
  }

  return {
    resources: makeResources(context, collected),
    title: collected.title || undefined,
    pageUrl,
  }
}

export const douyinParser: SiteParser = {
  id: "douyin",
  matches(url) {
    const host = url.match(/^https?:\/\/([^/:?#]+)/i)?.[1] || ""
    return /(?:^|\.)(?:douyin|iesdouyin)\.com$/i.test(host)
  },
  parse: parseDouyin,
}
