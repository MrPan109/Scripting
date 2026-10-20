import { fetch } from "scripting"
import type { ResourceItem } from "../types/resource"
import { sanitizeFileName } from "../utils/fileName"
import { formatByteSize } from "../utils/bytes"

/**
 * YouTube 镜像兜底。
 *
 * 背景：YouTube 从 2025 起对部分视频开启「SABR-only / 直链限流」，本机拿到的
 * googlevideo 直链往往只有开头几百 KB 能下，文件中段一律 403——
 * 解析能成功、下载必然失败。Invidious 公共实例会在服务端换到可用的直链，
 * 这里把它的格式清单搬过来，仍然用本机下载器（后台 URLSession / ffmpeg 合并）下载。
 *
 * 只把「视频 ID」这一条公开信息发给镜像，不带任何本地数据。
 */

const PROBE_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
  Accept: "*/*",
}

/**
 * 兜底实例表（2026-10 实测：Invidious 生态只剩极少数实例对外开放 API，
 * f5.si 是第一顺位；其余经常 401/403/404/418/5xx，所以并行问、谁通用谁）。
 */
const KNOWN_INSTANCES = [
  "https://invidious.f5.si",
  "https://invidious.tiekoetter.com",
  "https://yt.chocolatemoo53.com",
  "https://invidious.nerdvpn.de",
  "https://iv.melmac.space",
  "https://inv.nadeko.net",
  "https://yewtu.be",
  "https://invidious.privacyredirect.com",
]

const INSTANCE_CACHE_KEY = "watermarkToolbox.invidiousInstances"
const INSTANCE_CACHE_TTL = 12 * 60 * 60 * 1000
const MAX_INSTANCE_TRIES = 5
/** 单次镜像请求的硬上限：到点就放弃，不能让解析无限等 */
const MIRROR_REQUEST_TIMEOUT = 6000
const INSTANCE_LIST_TIMEOUT = 5000
/** 探活上限：403 通常几百毫秒就回，等太久说明卡住了 */
const PROBE_TIMEOUT = 6000

/** 谁先给出结果就用谁，不等最慢的那几个。 */
function firstHit<T>(promises: Array<Promise<T | null>>): Promise<T | null> {
  return new Promise<T | null>(resolve => {
    let pending = promises.length
    let settled = false
    const finish = (value: T | null) => {
      if (settled) return
      if (value) {
        settled = true
        resolve(value)
        return
      }
      pending -= 1
      if (pending <= 0) {
        settled = true
        resolve(null)
      }
    }
    if (pending === 0) {
      resolve(null)
      return
    }
    for (const promise of promises) {
      promise.then(value => finish(value)).catch(() => finish(null))
    }
  })
}

/** 给任何 promise 套一个硬超时（fetch 自己的 timeout 不保证会中断请求）。 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise<T | undefined>(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve(undefined)
    }, ms)
    promise
      .then(value => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(undefined)
      })
  })
}

type InstanceCache = { at: number; list: string[] }

function readInstanceCache(): string[] {
  try {
    const cached = Storage.get<InstanceCache>(INSTANCE_CACHE_KEY)
    if (!cached || !Array.isArray(cached.list) || cached.list.length === 0) return []
    if (Date.now() - (cached.at || 0) > INSTANCE_CACHE_TTL) return []
    return cached.list
  } catch {
    return []
  }
}

function writeInstanceCache(list: string[]) {
  try {
    Storage.set(INSTANCE_CACHE_KEY, { at: Date.now(), list } satisfies InstanceCache)
  } catch {}
}

/** 从 Invidious 官方清单挑「API 开着且在线」的 https 实例。 */
async function refreshInstances(): Promise<string[]> {
  try {
    const response = await withTimeout(
      fetch("https://api.invidious.io/instances.json?sort_by=health", {
        headers: PROBE_HEADERS,
        timeout: INSTANCE_LIST_TIMEOUT,
        allowInsecureRequest: true,
      }),
      INSTANCE_LIST_TIMEOUT + 2000,
    )
    if (!response || !response.ok) return []
    const raw = await response.json() as any
    if (!Array.isArray(raw)) return []

    const list: string[] = []
    for (const entry of raw) {
      const info = Array.isArray(entry) ? entry[1] : undefined
      if (!info || info.type !== "https") continue
      if (info.monitor?.down === true) continue
      const uri = typeof info.uri === "string" ? info.uri.replace(/\/+$/, "") : ""
      if (uri.startsWith("https://")) list.push(uri)
    }
    if (list.length > 0) {
      writeInstanceCache(list)
      return list
    }
  } catch {}
  return []
}

export type MirrorFormat = {
  itag: string
  url: string
  mime: string
  width: number
  height: number
  qualityLabel: string
  size: number
  bitrate: number
  fps?: number
  /** 仅显式尺寸用于实际尺寸标签，height 可能由画质名推导。 */
  actualHeight?: number
}

export type YouTubeMirror = {
  title?: string
  durationSeconds?: number
  instance: string
  /** 自带音轨的合一格式（itag 18 之类），最好下、不用合并 */
  muxed: MirrorFormat[]
  /** 只有画面（DASH），要和音轨合并 */
  video: MirrorFormat[]
  /** 只有声音（m4a） */
  audio: MirrorFormat[]
}

function toNumber(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function heightOf(item: any): number {
  const explicit = toNumber(item?.height)
  if (explicit > 0) return explicit
  const fromResolution = typeof item?.resolution === "string" ? item.resolution.match(/(\d{3,4})p/) : null
  if (fromResolution) return toNumber(fromResolution[1])
  return toNumber(item?.height)
}

function normalizeURL(raw: unknown, base: string): string {
  const text = typeof raw === "string" ? raw : ""
  if (!text) return ""
  if (text.startsWith("//")) return `https:${text}`
  if (text.startsWith("/")) return `${base}${text}`
  return text
}

function makeFormat(item: any, base: string): MirrorFormat | null {
  const url = normalizeURL(item?.url, base)
  if (!url) return null
  const mime = typeof item?.type === "string" ? item.type : ""
  const height = heightOf(item)
  return {
    itag: String(item?.itag ?? ""),
    url,
    mime,
    width: toNumber(item?.width),
    height,
    qualityLabel: typeof item?.resolution === "string" && item.resolution ? item.resolution : height ? `${height}p` : "",
    size: toNumber(item?.clen ?? item?.contentLength ?? 0),
    bitrate: toNumber(item?.bitrate),
    fps: toNumber(item?.fps),
    actualHeight: toNumber(item?.height),
  }
}

function collect(data: any, base: string): Pick<YouTubeMirror, "muxed" | "video" | "audio"> {
  const muxed: MirrorFormat[] = []
  const video: MirrorFormat[] = []
  const audio: MirrorFormat[] = []

  for (const item of Array.isArray(data?.formatStreams) ? data.formatStreams : []) {
    const format = makeFormat(item, base)
    if (format && /^video\/mp4/i.test(format.mime)) muxed.push(format)
  }

  for (const item of Array.isArray(data?.adaptiveFormats) ? data.adaptiveFormats : []) {
    const format = makeFormat(item, base)
    if (!format) continue
    // 只留 ffmpeg 能直接 copy 的组合：H.264 画面 + m4a 声音
    if (/^video\/mp4/i.test(format.mime) && /avc1/i.test(format.mime) && format.height > 0) {
      video.push(format)
    } else if (/^audio\/mp4/i.test(format.mime)) {
      audio.push(format)
    }
  }

  const byHeight = (a: MirrorFormat, b: MirrorFormat) => b.height - a.height || b.bitrate - a.bitrate
  const byBitrate = (a: MirrorFormat, b: MirrorFormat) => b.bitrate - a.bitrate

  return {
    muxed: muxed.sort(byHeight),
    video: video.sort(byHeight),
    audio: audio.sort(byBitrate),
  }
}

/**
 * 取文件中段 1KB 试一下：本机直链在限流/SABR-only 时只有开头能取，中段直接 403。
 * 这是判断「这条地址能不能真的下完整」最省事的办法；顺便从 Content-Range 里拿到文件总大小。
 */
export async function probeDirectDownload(
  url: string,
  totalSize?: number,
  headers?: Record<string, string>,
): Promise<{ ok: boolean; size: number }> {
  if (!url) return { ok: false, size: 0 }
  const size = toNumber(totalSize)
  const offset = size > 4 * 1024 * 1024 ? Math.floor(size / 2) : 8 * 1024 * 1024
  const end = offset + 1023
  try {
    const response = await withTimeout(
      fetch(url, {
        headers: { ...PROBE_HEADERS, ...headers, Range: `bytes=${offset}-${end}` },
        timeout: PROBE_TIMEOUT,
        allowInsecureRequest: true,
      }),
      PROBE_TIMEOUT + 2000,
    )
    if (!response) return { ok: false, size: 0 }
    if (response.status === 206) {
      const probeSize = contentLengthFrom(response.headers)
      return { ok: true, size: probeSize > 0 ? probeSize : size }
    }
    // 只有「小文件」才接受 200：googlevideo 忽略 Range 回 200 时后面跟着整部文件，
    // 当“可用”会让运行时去缓存几个 GB，反而把 App 卡死。
    if (response.ok && toNumber(response.headers.get("content-length")) <= 2 * 1024 * 1024) {
      return { ok: true, size: size }
    }
    return { ok: false, size: 0 }
  } catch {
    return { ok: false, size: 0 }
  }
}

/** 从 Content-Range（bytes a-b/total）或 Content-Length 里读文件总大小。 */
function contentLengthFrom(headers: { get(name: string): string | null }): number {
  const range = headers.get("content-range") || ""
  const total = range.match(/\/(\d+)\s*$/)?.[1]
  if (total) return toNumber(total)
  return toNumber(headers.get("content-length"))
}

export async function isDirectlyDownloadable(
  url: string,
  totalSize?: number,
  headers?: Record<string, string>,
): Promise<boolean> {
  return (await probeDirectDownload(url, totalSize, headers)).ok
}

async function requestMirror(videoId: string, instance: string): Promise<YouTubeMirror | null> {
  try {
    const url = `${instance}/api/v1/videos/${encodeURIComponent(videoId)}`
    const response = await withTimeout(
      fetch(url, { headers: PROBE_HEADERS, timeout: MIRROR_REQUEST_TIMEOUT, allowInsecureRequest: true }),
      MIRROR_REQUEST_TIMEOUT + 2000,
    )
    if (!response || !response.ok) return null
    const data = await response.json() as any
    if (!data || data.error) return null
    const formats = collect(data, instance)
    if (formats.muxed.length + formats.video.length + formats.audio.length === 0) return null
    return {
      title: typeof data.title === "string" ? data.title : undefined,
      durationSeconds: toNumber(data.lengthSeconds) > 0 ? toNumber(data.lengthSeconds) : undefined,
      instance,
      ...formats,
    }
  } catch {
    return null
  }
}

/**
 * 问公共镜像要格式清单。
 *
 * 镜像很不稳定（实例经常挂/限流/被反爬），所以：
 * 多个实例**并行**问、每个都带硬超时，谁先给出格式就用谁；全不行才去刷新实例列表再试一批。
 */
export async function fetchYouTubeMirror(videoId: string): Promise<YouTubeMirror | null> {
  if (!videoId) return null
  const cached = readInstanceCache()
  const tried = new Set<string>()
  const merge = (list: string[]) => list.filter(instance => instance && !tried.has(instance))

  const first = merge([...cached, ...KNOWN_INSTANCES]).slice(0, MAX_INSTANCE_TRIES)
  first.forEach(instance => tried.add(instance))
  const hit = await firstHit(first.map(instance => requestMirror(videoId, instance)))
  if (hit) return hit

  const refreshed = await withTimeout(refreshInstances(), INSTANCE_LIST_TIMEOUT)
  const more = merge(refreshed ?? []).slice(0, MAX_INSTANCE_TRIES)
  if (more.length === 0) return null
  return await firstHit(more.map(instance => requestMirror(videoId, instance)))
}

export type YouTubeMirrorResources = {
  resources: ResourceItem[]
  title?: string
  instance: string
}

function mirrorQuality(format: MirrorFormat): string {
  const positive = (value: number | undefined) => Number.isFinite(value) && (value || 0) > 0
  return [format.qualityLabel,
    positive(format.width) && positive(format.actualHeight) ? `${format.width}×${format.actualHeight}` : "",
    positive(format.fps) ? `${format.fps}fps` : "",
    positive(format.bitrate) ? `${format.bitrate / 1000}kbps` : "",
  ].filter(Boolean).join(" · ")
}

/** 音轨和两类视频共享四个探活槽位，结果顺序与输入一致。 */
async function probeFormats(formats: MirrorFormat[], headers: Record<string, string>) {
  const results: Array<{ ok: boolean; size: number }> = new Array(formats.length)
  let next = 0
  const worker = async () => {
    while (next < formats.length) {
      const index = next++
      const format = formats[index]
      results[index] = await probeDirectDownload(format.url, format.size, headers)
        .catch(() => ({ ok: false, size: 0 }))
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, formats.length) }, worker))
  return results
}

/**
 * 把镜像格式整理成可下载的资源条目。
 *
 * 镜像给的直链是实例缓存里的，有时已经接近过期（探活会 403）。
 * 探活只补充大小和受限提示，不隐藏来源画质；
 * 真正下载前会再取一次新直链（见 refreshMirrorResourceURLs）。
 */
export async function buildYouTubeMirrorResources(
  videoId: string,
  fallbackTitle: string | undefined,
  sourceUrl: string,
): Promise<YouTubeMirrorResources | null> {
  const mirror = await fetchYouTubeMirror(videoId)
  if (!mirror) return null

  const title = sanitizeFileName(mirror.title || fallbackTitle || videoId, videoId)
  const headers = { Referer: `${mirror.instance}/` }
  const bestAudio = mirror.audio[0]

  // 保留全部来源版本；相同高度的 DASH / 合一格式可能具有不同帧率和码率。
  const muxed = mirror.muxed
  const dashVideo = bestAudio ? mirror.video : []
  const variantKey = (format: MirrorFormat, hasAudio: boolean) => JSON.stringify([
    format.width, format.height, format.fps || 0, format.bitrate, format.mime,
    format.qualityLabel, hasAudio,
  ])

  const probes = await probeFormats([...dashVideo, ...muxed, ...(bestAudio ? [bestAudio] : [])], headers)
  const videoProbes = probes.slice(0, dashVideo.length)
  const muxedProbes = probes.slice(dashVideo.length, dashVideo.length + muxed.length)
  const audioProbe = bestAudio ? probes[probes.length - 1] : { ok: false, size: 0 }
  const audioSize = audioProbe.size || bestAudio?.size || 0
  const restricted = "直链受限，下载前刷新"

  const resources: ResourceItem[] = []
  const seen = new Set<string>()

  dashVideo.forEach((format, index) => {
    if (!bestAudio) return
    const key = variantKey(format, false)
    if (seen.has(key)) return
    seen.add(key)
    const videoSize = videoProbes[index].size || format.size
    resources.push({
      type: "video",
      url: format.url,
      audioUrl: bestAudio.url,
      byteSize: videoSize,
      audioByteSize: audioSize,
      videoFormatId: format.itag,
      audioFormatId: bestAudio.itag,
      name: `${title}_${mirrorQuality(format) || "视频"}.mp4`,
      source: "youtube",
      quality: [mirrorQuality(format), formatByteSize(videoSize + audioSize), "镜像",
        videoProbes[index].ok && audioProbe.ok ? "" : restricted].filter(Boolean).join(" · "),
      format: format.itag,
      width: format.width,
      height: format.height,
      durationSeconds: mirror.durationSeconds,
      headers,
      sourceUrl,
    })
  })

  muxed.forEach((format, index) => {
    const key = variantKey(format, true)
    if (seen.has(key)) return
    seen.add(key)
    const size = muxedProbes[index].size || format.size
    resources.push({
      type: "video",
      url: format.url,
      byteSize: size,
      videoFormatId: format.itag,
      name: `${title}_${mirrorQuality(format) || "合一"}.mp4`,
      source: "youtube",
      quality: [mirrorQuality(format) || "合一", formatByteSize(size), "镜像",
        muxedProbes[index].ok ? "" : restricted].filter(Boolean).join(" · "),
      format: format.itag,
      width: format.width,
      height: format.height,
      durationSeconds: mirror.durationSeconds,
      headers,
      sourceUrl,
    })
  })

  if (bestAudio) {
    resources.push({
      type: "audio",
      url: bestAudio.url,
      byteSize: audioSize,
      videoFormatId: bestAudio.itag,
      name: `${title}_音频.m4a`,
      source: "youtube",
      quality: ["纯音频", formatByteSize(audioSize), "镜像",
        audioProbe.ok ? "" : restricted].filter(Boolean).join(" · "),
      format: "m4a",
      headers,
      sourceUrl,
    })
  }

  if (resources.length === 0) return null
  return { resources, title: mirror.title || fallbackTitle, instance: mirror.instance }
}

/**
 * 下载前重取一次直链：镜像缓存里的地址可能已过期，
 * 用 itag 去镜像要一份新的，并探活确认能分段下载。
 */
export async function refreshMirrorResourceURLs(
  resource: ResourceItem,
): Promise<{ url: string; audioUrl?: string; headers?: Record<string, string> } | null> {
  const videoId = resource.sourceUrl?.match(/[?&]v=([A-Za-z0-9_-]{5,})/)?.[1]
  const videoItag = resource.videoFormatId
  if (!videoId || !videoItag) return null

  const mirror = await fetchYouTubeMirror(videoId)
  if (!mirror) return null
  const headers = { Referer: `${mirror.instance}/` }

  const all = [...mirror.muxed, ...mirror.video, ...mirror.audio]
  const pick = (itag: string | undefined) => (itag ? all.find(format => format.itag === itag) : undefined)

  const videoFormat = pick(videoItag)
  if (!videoFormat) return null
  const videoProbe = await probeDirectDownload(videoFormat.url, videoFormat.size, headers)
  if (!videoProbe.ok) return null

  const result: { url: string; audioUrl?: string; headers?: Record<string, string> } = {
    url: videoFormat.url,
    headers,
  }

  if (resource.audioUrl) {
    const audioFormat = pick(resource.audioFormatId)
    const audioProbe = audioFormat ? await probeDirectDownload(audioFormat.url, audioFormat.size, headers) : { ok: false, size: 0 }
    if (!audioProbe.ok) return null
    result.audioUrl = audioFormat!.url
  }

  return result
}
