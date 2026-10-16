import { fetch } from "scripting"

export type Platform = "xiaohongshu" | "douyin"
export type MediaKind = "image" | "video" | "audio" | "livePhoto"

export interface MediaItem {
  id: string
  kind: MediaKind
  label: string
  url: string
  previewUrl?: string
  fileName: string
  alternateUrls?: string[]
  /** 所选 url 对应的像素尺寸与文件字节数；未知时留空。 */
  width?: number
  height?: number
  byteSize?: number
  /** 媒体时长，单位为秒。 */
  durationSeconds?: number
  /** 实况照片的高清静帧（原始无水印图），用于单独另存静图 */
  stillUrl?: string
  /** 实况动态片段的时长（毫秒）：界面用它提示声音可播放的长度 */
  durationMs?: number
}

export interface ParseResult {
  platform: Platform
  title: string
  author?: string
  sourceUrl: string
  media: MediaItem[]
  privacyNotice?: string
}

const URL_PATTERN = /https?:\/\/[^\s<>"'，。！？、]+/gi
const XHS_HOSTS = ["xiaohongshu.com", "xhslink.cn"]
const DOUYIN_HOSTS = ["douyin.com", "iesdouyin.com"]
const SHORT_LINK_HOSTS = ["xhslink.cn", "v.douyin.com"]
export const BROWSER_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"

function hostMatches(hostname: string, domains: string[]): boolean {
  const host = hostname.toLowerCase()
  return domains.some(domain => host === domain || host.endsWith(`.${domain}`))
}

export function extractSupportedURL(input: string): string {
  const candidates = input.match(URL_PATTERN) ?? []
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate)
      if (hostMatches(url.hostname, [...XHS_HOSTS, ...DOUYIN_HOSTS])) return url.toString()
    } catch {}
  }
  throw new Error("没有找到受支持的作品链接")
}

function normalizedDouyinURL(urlString: string): string {
  const url = new URL(urlString)
  const videoId = url.pathname.match(/(?:video|share\/video)\/(\d{8,})/)?.[1]
  if (videoId) return `https://www.douyin.com/video/${videoId}`
  // 图集（图文）作品：share/note/{id} 或 note/{id}
  const noteId = url.pathname.match(/(?:note|share\/note)\/(\d{8,})/)?.[1]
  if (noteId) return `https://www.douyin.com/note/${noteId}`
  return url.toString()
}

export async function expandShortLink(urlString: string): Promise<string> {
  const initial = new URL(urlString)
  if (!hostMatches(initial.hostname, SHORT_LINK_HOSTS)) return initial.toString()

  const response = await fetch(initial.toString(), {
    headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    timeout: 30,
  })
  const resolvedURL = response.url || initial.toString()
  if (!response.ok) throw new Error(`短链请求失败（${response.status}），请重新复制来源页面的分享链接`)
  if (!hostMatches(new URL(resolvedURL).hostname, [...XHS_HOSTS, ...DOUYIN_HOSTS])) {
    throw new Error("短链未跳转到受支持的作品页面")
  }
  return detectPlatform(resolvedURL) === "douyin" ? normalizedDouyinURL(resolvedURL) : resolvedURL
}

export function detectPlatform(urlString: string): Platform {
  const host = new URL(urlString).hostname
  if (hostMatches(host, XHS_HOSTS)) return "xiaohongshu"
  if (hostMatches(host, DOUYIN_HOSTS)) return "douyin"
  throw new Error("暂不支持该来源页面")
}

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
}

export function assertSafeMediaURL(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("媒体地址为空")
  const url = new URL(value.replaceAll("\\u002F", "/"))
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("媒体地址协议不受支持")
  const host = url.hostname.toLowerCase()
  if (host === "localhost" || host === "::1" || host.endsWith(".local") || isPrivateIPv4(host)) {
    throw new Error("已拒绝不安全的媒体地址")
  }
  return url.toString()
}

function replaceBareJavaScriptValues(source: string): string {
  let output = ""
  let quote = ""
  let escaped = false
  let index = 0
  const replacements: Record<string, string> = { undefined: "null", NaN: "null", Infinity: "null" }

  while (index < source.length) {
    const char = source[index]
    if (quote) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = ""
      index += 1
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      output += char
      index += 1
      continue
    }
    const match = source.slice(index).match(/^(undefined|NaN|Infinity)\b/)
    if (match) {
      output += replacements[match[1]]
      index += match[1].length
      continue
    }
    output += char
    index += 1
  }
  return output
}

function extractInitialState(html: string): any {
  const markerMatch = /window\.__INITIAL_STATE__\s*=/.exec(html)
  if (!markerMatch) {
    if (/验证|verify|captcha|安全检查|访问频繁/i.test(html)) throw new Error("来源页面触发了访问验证，请稍后重试或先在来源应用内打开该作品")
    throw new Error("页面没有公开媒体数据，可能需要登录或链接已失效")
  }
  const markerIndex = markerMatch.index
  const start = html.indexOf("{", markerIndex + markerMatch[0].length)
  if (start < 0) throw new Error("无法读取来源页面状态")

  let depth = 0
  let quote = ""
  let escaped = false
  for (let index = start; index < html.length; index += 1) {
    const char = html[index]
    if (quote) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === quote) quote = ""
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === "{") depth += 1
    if (char === "}") {
      depth -= 1
      if (depth === 0) {
        const literal = html.slice(start, index + 1)
        try {
          return JSON.parse(replaceBareJavaScriptValues(literal))
        } catch {
          throw new Error("来源页面数据格式已变化")
        }
      }
    }
  }
  throw new Error("来源页面数据不完整")
}

function noteIDFromURL(urlString: string): string | undefined {
  const pathParts = new URL(urlString).pathname.split("/").filter(Boolean)
  const itemIndex = pathParts.findIndex(part => part === "item")
  if (itemIndex >= 0) return pathParts[itemIndex + 1]
  const exploreIndex = pathParts.findIndex(part => part === "explore" || part === "discovery")
  return exploreIndex >= 0 ? pathParts[exploreIndex + 1] : undefined
}

function collectNotes(value: any, output: any[] = [], seen = new Set<any>()): any[] {
  if (!value || typeof value !== "object" || seen.has(value) || output.length > 100) return output
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach(item => collectNotes(item, output, seen))
    return output
  }
  const looksLikeNote = typeof value.noteId === "string" || typeof value.id === "string"
    ? (value.imageList || value.video || value.noteCard || value.displayTitle || value.title)
    : false
  if (looksLikeNote) output.push(value)
  Object.values(value).forEach(child => collectNotes(child, output, seen))
  return output
}

function firstString(...values: unknown[]): string | undefined {
  return values.find(value => typeof value === "string" && value.length > 0) as string | undefined
}

/** 从页面 HTML 里找标题（og:title 优先，其次 <title>），用于页面数据里没带标题时兜底。 */
function titleFromHTML(html: string): string | undefined {
  const decode = (value: string) => value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim()
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1]
  if (og && decode(og)) return decode(og)
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]
  const cleaned = title ? decode(title).replace(/\s*[-_]\s*小红书\s*$/i, "").trim() : ""
  // 页面在登录墙后面时 <title> 只剩站点名，这种没信息量的就不当标题用
  if (cleaned.length < 3 || cleaned === "小红书") return undefined
  return cleaned
}

function imageURLCandidates(image: any): string[] {
  const candidates: Array<{ value: unknown; score: number }> = []
  const add = (value: unknown, score: number) => {
    if (typeof value !== "string" || value.length === 0) return
    candidates.push({ value, score })
  }

  // Prefer original/native CDN variants. Keep the complete signed URL intact:
  // XHS may include the `!` transform in its signature, so stripping it can
  // turn a valid media URL into HTTP 403.
  add(image?.originUrl, 120)
  add(image?.originalUrl, 120)
  add(image?.urlOriginal, 120)
  add(image?.url, 100)
  add(image?.urlPre, 95)
  add(image?.urlDefault, 80)
  if (Array.isArray(image?.infoList)) {
    image.infoList.forEach((scene: any) => {
      const name = String(scene?.imageScene ?? "").toUpperCase()
      const score = name.includes("ORIGIN") || name.includes("ORIGINAL") ? 125
        : name.includes("WB_DFT") ? 70
        : name.includes("WB_PRV") || name.includes("PRV") ? 60
        : 90
      add(scene?.url, score)
      add(scene?.urlDefault, score - 5)
    })
  }

  const seen = new Set<string>()
  return candidates
    .filter(candidate => {
      if (typeof candidate.value !== "string" || seen.has(candidate.value)) return false
      seen.add(candidate.value)
      return true
    })
    .sort((left, right) => {
      const hostScore = (value: string) => {
        try {
          const host = new URL(value).hostname.toLowerCase()
          if (host.endsWith("xhscdn.com")) return 30
          if (host === "ci.xiaohongshu.com") return -30
        } catch {}
        return 0
      }
      return right.score + hostScore(String(right.value)) - (left.score + hostScore(String(left.value)))
    })
    .map(candidate => String(candidate.value))
}

function originalXHSImageURL(image: any): string {
  // The raw object on the app image CDN (no `!` template suffix) is the
  // original, watermark-free JPEG. The `!h5_*` webpic URLs are web-only
  // variants that already carry the watermark, and stripping their suffix
  // returns 403, so build the original URL from the fileId instead.
  // fileId may carry a path prefix such as `notes_pre_post/` or
  // `note_pre_post_uhdr/` (regular photo notes) or be a bare object key
  // (video covers / live photos).
  const fileId = firstString(image?.fileId, image?.fileid)
  if (fileId && /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?$/.test(fileId)) {
    return assertSafeMediaURL(`https://sns-img-bd.xhscdn.com/${fileId}`)
  }
  for (const candidate of imageURLCandidates(image)) {
    try { return assertSafeMediaURL(candidate) } catch {}
  }
  throw new Error("图片地址为空或格式不受支持")
}

function streamScore(stream: any): number[] {
  return [
    Number(stream?.width ?? 0) * Number(stream?.height ?? 0),
    Number(stream?.videoBitrate ?? stream?.avgBitrate ?? stream?.bitrate ?? 0),
    Number(stream?.size ?? 0),
    Number(stream?.fps ?? 0),
  ]
}

function compareStreams(left: any, right: any): number {
  const a = streamScore(left)
  const b = streamScore(right)
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index]
  }
  const leftH264 = String(left?.videoCodec ?? left?.codec ?? "").toLowerCase().includes("264") ? 1 : 0
  const rightH264 = String(right?.videoCodec ?? right?.codec ?? "").toLowerCase().includes("264") ? 1 : 0
  return rightH264 - leftH264
}

function bestXHSLivePhotoStream(image: any): { url: string; durationMs?: number } | undefined {
  // 小红书图文实况图：每张图的 `stream` 里带着自己的短视频（streamDesc
  // 形如 WEB_LIVEPHOTO_19，无音轨、约 2 秒），这就是"实况"的动态部分。
  // 静帧则是同一张图的 fileId 原图，两者配对后即构成实况照片。
  const streamObject = image?.stream
  const streams: any[] = streamObject && typeof streamObject === "object"
    ? Object.values(streamObject).flatMap((value: any) => Array.isArray(value) ? value : [])
    : []
  streams.sort((left, right) => {
    const liveLeft = String(left?.streamDesc ?? "").toUpperCase().includes("LIVEPHOTO") ? 1 : 0
    const liveRight = String(right?.streamDesc ?? "").toUpperCase().includes("LIVEPHOTO") ? 1 : 0
    if (liveLeft !== liveRight) return liveRight - liveLeft
    return compareStreams(left, right)
  })
  for (const stream of streams) {
    const candidate = firstString(stream?.masterUrl, stream?.backupUrls?.[0])
    if (candidate) {
      const rawDuration = Number(stream?.duration ?? stream?.videoDuration ?? 0)
      return {
        url: assertSafeMediaURL(candidate.replace(/^http:\/\//i, "https://")),
        durationMs: Number.isFinite(rawDuration) && rawDuration > 0 ? Math.round(rawDuration) : undefined,
      }
    }
  }
  return undefined
}

function positiveFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function bestXHSVideoURL(note: any): Pick<MediaItem, "url" | "width" | "height" | "byteSize" | "durationSeconds"> | undefined {
  const originKey = firstString(note?.video?.consumer?.originVideoKey)
  // originVideoKey 没有与 media.video 元数据建立明确绑定，不能借用转码流的字段。
  if (originKey) return { url: assertSafeMediaURL(`https://sns-video-bd.xhscdn.com/${originKey.replace(/^\/+/, "")}`) }

  const streamObject = note?.video?.media?.stream
  const streams = streamObject && typeof streamObject === "object"
    ? Object.values(streamObject).flatMap(value => Array.isArray(value) ? value : [])
    : []
  streams.sort(compareStreams)
  for (const stream of streams) {
    const candidate = firstString((stream as any)?.masterUrl, (stream as any)?.backupUrls?.[0])
    if (candidate) {
      // XHS 转码流的 size 为字节，duration 为毫秒；只读取所选流，不猜其他别名的单位。
      const durationMs = positiveFiniteNumber(stream?.duration)
      return {
        url: assertSafeMediaURL(candidate),
        width: positiveFiniteNumber(stream?.width),
        height: positiveFiniteNumber(stream?.height),
        byteSize: positiveFiniteNumber(stream?.size),
        durationSeconds: durationMs === undefined ? undefined : durationMs / 1000,
      }
    }
  }
  return undefined
}

async function parseXiaohongshu(sourceUrl: string): Promise<ParseResult> {
  const response = await fetch(sourceUrl, {
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
  })
  if (!response.ok) throw new Error(`来源页面请求失败（${response.status}）`)
  const resolvedURL = response.url || sourceUrl
  const html = await response.text()
  const state = extractInitialState(html)
  const detailMap = state?.note?.noteDetailMap ?? state?.noteDetailMap ?? {}
  const noteID = noteIDFromURL(resolvedURL) ?? noteIDFromURL(sourceUrl)
  const mappedNotes = Object.values(detailMap)
    .map((detail: any) => detail?.note ?? detail)
    .filter((item: any) => item && typeof item === "object")
  const stateNotes = collectNotes(state)
  const candidates = [...mappedNotes, ...stateNotes].filter((item, index, all) => all.indexOf(item) === index)
  const note = candidates.find((item: any) => noteID && (item.noteId === noteID || item.id === noteID))
    ?? (candidates.length === 1 ? candidates[0] : undefined)
    ?? candidates.find((item: any) => item.imageList || item.video)
  if (!note) throw new Error("没有找到该作品，页面可能触发了访问验证或来源页面结构已变化")

  const title = firstString(note.title, note.displayTitle, note.desc) ?? titleFromHTML(html) ?? "来源作品"
  const author = firstString(note?.user?.nickname, note?.user?.nickName)
  const media: MediaItem[] = []
  const isVideoNote = Boolean(note.video)
  if (Array.isArray(note.imageList)) {
    note.imageList.forEach((image: any, index: number) => {
      try {
        const url = originalXHSImageURL(image)
        const alternates = imageURLCandidates(image).map(value => {
          try { return assertSafeMediaURL(value) } catch { return "" }
        }).filter(value => value.length > 0 && value !== url)
        const live = image?.livePhoto === true ? bestXHSLivePhotoStream(image) : undefined
        if (live) {
          media.push({ id: `live-${index}`, kind: "livePhoto", label: `实况照片 ${index + 1}`, url: live.url, previewUrl: url, stillUrl: url, durationMs: live.durationMs, fileName: `xiaohongshu-live-${index + 1}.mp4` })
          return
        }
        const label = isVideoNote && note.imageList.length === 1 ? "静态图" : `图片 ${index + 1}`
        media.push({ id: `image-${index}`, kind: "image", label, url, alternateUrls: alternates, previewUrl: url, fileName: `xiaohongshu-${index + 1}.jpg` })
      } catch {}
    })
  }
  const video = bestXHSVideoURL(note)
  if (video) {
    media.unshift({ id: "video", kind: "video", label: "视频", ...video, previewUrl: media[0]?.previewUrl, fileName: "xiaohongshu-video.mp4" })
  }
  if (media.length === 0) throw new Error("该笔记没有可保存的公开图片或视频")
  return { platform: "xiaohongshu", title, author, sourceUrl: resolvedURL, media }
}

/** 等待一小段时（用于等 WebView 渲染）。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise<void>(resolve => { setTimeout(() => resolve(), milliseconds) })
}

/** 在抖音页面里读取渲染后的播放信息（必须用 return 返回）。 */
const DOUYIN_PROBE_SCRIPT = `return (() => {
  const v = document.querySelector('video')
  return JSON.stringify({
    title: document.title,
    src: v ? (v.currentSrc || v.src || '') : '',
    poster: v ? (v.poster || '') : '',
    durationSeconds: v && Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null,
  })
})()`

/**
 * 本机解析抖音：用应用内 WebView 渲染分享页（抖音的页面数据是 JS 渲染的，
 * 直接 HTTP 拉取只有空壳，服务端接口需要 a_bogus 签名），
 * 从渲染结果里取 video_id，再用官方播放端点拿无水印流（playwm 才是带水印的）。
 * 全程在本机完成，不把链接交给第三方。
 */
async function parseDouyinNative(normalizedURL: string): Promise<ParseResult | null> {
  // 只解析视频：图文/图集（/note/）本机暂未实现，直接返回 null 交给回退路径，
  // 避免用 /video/ 页面去套一个图文页白等 12 秒。
  const id = normalizedURL.match(/(?:video|share\/video)\/(\d{15,})/)?.[1]
  if (!id) return null

  const webView = new WebViewController({ ephemeral: true })
  let pageTitle = ""
  let poster = ""
  let videoID = ""
  let durationSeconds: number | undefined
  try {
    webView.setCustomUserAgent(BROWSER_USER_AGENT)
    // 抖音页面会持续发请求，loadURL 永远不 resolve，所以不等待它。
    void webView.loadURL(`https://www.douyin.com/video/${id}`).catch(() => false)
    for (let attempt = 0; attempt < 10 && !videoID; attempt += 1) {
      await delay(1200)
      try {
        const raw = await webView.evaluateJavaScript<string>(DOUYIN_PROBE_SCRIPT)
        const info = typeof raw === "string" ? JSON.parse(raw) : raw
        if (typeof info?.title === "string" && info.title.length > 0) pageTitle = info.title
        if (typeof info?.poster === "string" && info.poster.length > 0) poster = info.poster
        videoID = String(info?.src ?? "").match(/video_id=([A-Za-z0-9_-]+)/)?.[1] ?? ""
        if (videoID) durationSeconds = positiveFiniteNumber(info?.durationSeconds)
      } catch {}
    }
  } finally {
    try { webView.dispose() } catch {}
  }
  if (!videoID) return null

  const playURL = (ratio: string) => assertSafeMediaURL(`https://aweme.snssdk.com/aweme/v1/play/?video_id=${videoID}&ratio=${ratio}`)
  const media: MediaItem[] = [{
    id: "video",
    kind: "video",
    label: "视频",
    url: playURL("1080p"),
    alternateUrls: [playURL("720p"), assertSafeMediaURL(`https://m.douyin.com/aweme/v1/playwm/?video_id=${videoID}&ratio=720p&line=0`)],
    previewUrl: poster.length > 0 ? assertSafeMediaURL(poster) : undefined,
    fileName: "douyin-video.mp4",
    // currentSrc 与请求的 1080p 流不一定相同；仅保留内容时长，不沿用页面尺寸或大小。
    durationSeconds,
  }]
  try {
    const cover = assertSafeMediaURL(poster)
    media.push({ id: "cover", kind: "image", label: "视频封面", url: cover, previewUrl: cover, fileName: "douyin-cover.jpg" })
  } catch {}

  return {
    platform: "douyin",
    title: pageTitle.replace(/\s*-\s*抖音\s*$/, "").trim() || "来源作品",
    sourceUrl: normalizedURL,
    media,
    privacyNotice: "本机解析，未使用第三方接口；媒体地址来自来源网站的播放接口，实际内容以下载结果为准。",
  }
}

function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&")
}

/** 从图片 URL 推断文件扩展名（抖音图集常是 .webp / .jpeg，直接用 .jpg 会错位）。 */
function imageFileExtension(urlString: string): string {
  try {
    const path = new URL(urlString).pathname
    const match = path.match(/\.(jpe?g|png|webp|gif|heic|avif)(?:$|[?:_])/i)
    return match ? match[1].toLowerCase() : "jpg"
  } catch {
    return "jpg"
  }
}

async function parseDouyin(sourceUrl: string): Promise<ParseResult> {
  const normalizedURL = normalizedDouyinURL(sourceUrl)

  // 优先本机解析：用应用内 WebView 渲染抖音页面，取真实 video_id，
  // 再用官方播放端点拿无水印流。不把用户链接交给任何第三方。
  const native = await parseDouyinNative(normalizedURL).catch(() => null)
  if (native) return native

  // 回退：第三方聚合接口（可能限流，且会把链接发往该服务）
  const response = await fetch("http://api.rcuts.com/Video/DouYin_All.php", {
    method: "POST",
    allowInsecureRequest: true,
    timeout: 12,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formEncode({ url: normalizedURL, token: "", clipboard: normalizedURL }),
  })
  if (!response.ok) throw new Error(`媒体解析服务请求失败（${response.status}）`)
  const result = await response.json() as any
  if (String(result?.code) !== "0") {
    const detail = firstString(result?.msg) ?? "未返回具体原因"
    throw new Error(`第三方解析服务当前不可用或拒绝该作品：${detail}`)
  }

  const media: MediaItem[] = []
  // 第三方未提供已确认的单位及 URL 对应关系，不将 size/duration 等字段猜成字节或秒。
  const add = (kind: MediaKind, label: string, value: unknown, fileName: string, previewUrl?: unknown) => {
    if (typeof value !== "string" || value.length === 0) return
    media.push({ id: `${kind}-${media.length}`, kind, label, url: assertSafeMediaURL(value), fileName, previewUrl: typeof previewUrl === "string" ? assertSafeMediaURL(previewUrl) : undefined })
  }
  const addImage = (index: number, value: unknown, previewUrl?: unknown) => {
    if (typeof value !== "string" || value.length === 0) return
    const ext = imageFileExtension(value)
    add("image", `图片 ${index + 1}`, value, `douyin-${index + 1}.${ext}`, previewUrl)
  }

  // 视频：video_url 是字符串；图文/图集：第三方把图片列表塞在 video_url 数组里。
  if (typeof result.video_url === "string") {
    add("video", "视频", result.video_url, "douyin-video.mp4", result.cover)
  } else if (Array.isArray(result.video_url)) {
    result.video_url.forEach((url: unknown, index: number) => addImage(index, url, url))
  }

  add("image", "视频封面", result.cover, "douyin-cover.jpg", result.cover)
  add("audio", "背景音乐", result.sound, "douyin-audio.mp3", result.sound_cover)
  add("image", "音乐封面", result.sound_cover, "douyin-music-cover.jpg", result.sound_cover)
  add("image", "作者头像", result.avatar, "douyin-avatar.jpg", result.avatar)
  if (Array.isArray(result.images)) {
    result.images.forEach((url: unknown, index: number) => addImage(index, url, url))
  }
  if (media.length === 0) throw new Error("解析服务没有返回可保存的媒体")

  return {
    platform: "douyin",
    title: firstString(result.video_name) ?? "来源作品",
    author: firstString(result.nickname),
    sourceUrl: normalizedURL,
    media,
    privacyNotice: "媒体解析由第三方明文 HTTP 服务完成；本工具仅提交作品链接，不发送其他剪贴板内容。",
  }
}

export async function parseShareText(input: string): Promise<ParseResult> {
  const url = extractSupportedURL(input.trim())
  const resolvedURL = await expandShortLink(url)
  return detectPlatform(resolvedURL) === "xiaohongshu" ? parseXiaohongshu(resolvedURL) : parseDouyin(resolvedURL)
}

/**
 * 抖音视频的【纯本机】解析：短链展开 → WebView 取 video_id → 官方 play 流（无水印）。
 * 不碰第三方，也不处理图文（图文返回 null）。给合并后的统一入口用。
 */
export async function parseDouyinVideoLocally(input: string): Promise<ParseResult | null> {
  const url = extractSupportedURL(input.trim())
  const resolvedURL = await expandShortLink(url)
  if (detectPlatform(resolvedURL) !== "douyin") return null
  return await parseDouyinNative(normalizedDouyinURL(resolvedURL)).catch(() => null)
}
