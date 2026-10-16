import { Script } from "scripting"
import { ensureYtDlpInstalled, ensureSabrComponents, ytDlpInstallPath } from "../ytDlpManager"
import type { ResourceItem } from "../../types/resource"
import { sanitizeFileName } from "../../utils/fileName"
import { positiveNumber } from "../../utils/videoMetadata"
import { formatByteSize } from "../../utils/bytes"
import { buildYouTubeMirrorResources, isDirectlyDownloadable } from "../../functions/youtubeMirror"
import { statusText, useYouTubeMirror } from "../../state/appState"
import type { SiteParser, SiteParseContext, SiteParseResult } from "./types"

const YOUTUBE_HEADERS = {
  Referer: "https://www.youtube.com/",
}

type YouTubeFormat = {
  formatId?: string
  url?: string
  ext?: string
  protocol?: string
  width?: number
  height?: number
  fps?: number
  vcodec?: string
  acodec?: string
  tbr?: number
  abr?: number
  contentLength?: string | number
  headers?: Record<string, string>
}

type YouTubeInfo = {
  /** 可选上游时长，单位秒；当前 Python 输出可能不提供。 */
  duration?: number
  id?: string
  title?: string
  thumbnail?: string
  formats?: YouTubeFormat[]
  error?: string
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function isAudioOnly(format: YouTubeFormat): boolean {
  return format.vcodec === "none" && !!format.acodec && format.acodec !== "none"
}

function isVideo(format: YouTubeFormat): boolean {
  return !!format.vcodec && format.vcodec !== "none" && !!format.height
}

function isMp4Video(format: YouTubeFormat): boolean {
  return isVideo(format) && format.ext === "mp4" && /^avc1/i.test(format.vcodec || "")
}

function headersFor(format: YouTubeFormat): Record<string, string> {
  return { ...format.headers, ...YOUTUBE_HEADERS }
}

function parseShellJson(output: string): YouTubeInfo {
  const lines = output.trim().split("\n").map(line => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index])
      if (value && typeof value === "object") return value
    } catch {}
  }
  return { error: output.trim() || "视频解析没有返回结果" }
}

async function requestYouTubeInfo(url: string): Promise<YouTubeInfo> {
  const command = `python ${quoteShellArg(`${Script.directory}/scripts/youtube_info.py`)} ${quoteShellArg(ytDlpInstallPath)} ${quoteShellArg(url)}`
  const result = await Shell.run(command, { cwd: Script.directory, timeout: 60 })
  const info = parseShellJson(result.output)
  if (result.timedOut) throw new Error("视频解析超时")
  if (result.exitCode !== 0 || info.error) throw new Error(info.error || "视频解析失败")
  return info
}

function formatQuality(format: YouTubeFormat): string {
  const frameRate = (format.fps || 0) >= 50 ? `${Math.round(format.fps || 0)}fps` : ""
  return `${format.height || 0}p${frameRate}`
}

function formatSizeLabel(format: YouTubeFormat): string {
  return formatByteSize(Number(format.contentLength))
}

function makeVideoResources(info: YouTubeInfo): ResourceItem[] {
  const formats = info.formats || []
  const title = sanitizeFileName(info.title || info.id || "youtube_video", "youtube_video")
  const bestAudio = formats
    .filter(format => isAudioOnly(format) && format.ext === "m4a" && format.url)
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0]
  const candidates = formats
    .filter(format => isMp4Video(format) && format.url)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0) || (b.tbr || 0) - (a.tbr || 0))
  const seen = new Set<string>()
  const resources: ResourceItem[] = []

  for (const format of candidates) {
    const quality = formatQuality(format)
    const hasAudio = !!format.acodec && format.acodec !== "none"
    if (seen.has(quality) || (!hasAudio && !bestAudio?.url)) continue
    seen.add(quality)
    // 时长很长的视频单个文件能到几 GB，把体积摆在名字里让用户自己选
    const sizeLabel = hasAudio ? formatSizeLabel(format) : formatSizeLabel(format)
    resources.push({
      type: "video",
      url: format.url!,
      audioUrl: hasAudio ? undefined : bestAudio?.url,
      byteSize: Number(format.contentLength) || undefined,
      audioByteSize: hasAudio ? undefined : Number(bestAudio?.contentLength) || undefined,
      name: `${title}_${quality}.mp4`,
      source: "youtube",
      quality: [quality, sizeLabel].filter(Boolean).join(" · "),
      format: format.vcodec || "mp4",
      width: format.width,
      height: format.height,
      durationSeconds: positiveNumber(info.duration),
      headers: headersFor(format),
      sourceUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(info.id || "")}`,
      videoFormatId: format.formatId,
      audioFormatId: hasAudio ? undefined : bestAudio?.formatId,
    })
  }

  if (info.thumbnail) {
    resources.push({
      type: "image",
      url: info.thumbnail,
      name: `${title}_cover.jpg`,
      source: "youtube",
      likelyThumbnail: true,
      headers: YOUTUBE_HEADERS,
    })
  }
  return resources
}

function extractVideoId(url: string): string {
  const patterns = [
    /(?:youtube\.com\/watch\?[^#]*\bv=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([A-Za-z0-9_-]{5,})/,
  ]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match) return match[1]
  }
  return ""
}

/** 挑一条最有代表性的直链来探活：优先选中体积最高、且需要合并音轨的 DASH 视频。 */
function pickProbeFormat(info: YouTubeInfo): YouTubeFormat | undefined {
  const candidates = (info.formats || []).filter(format => isMp4Video(format) && format.url)
  if (candidates.length === 0) return (info.formats || []).find(format => !!format.url)
  return candidates.sort((a, b) => (b.height || 0) - (a.height || 0))[0]
}

async function parseYouTube(context: SiteParseContext): Promise<SiteParseResult> {
  const videoId = extractVideoId(context.url)

  let info: YouTubeInfo | undefined
  if (await ensureYtDlpInstalled(true)) {
    statusText.setValue("正在解析视频信息...")
    await ensureSabrComponents(true)
    info = await requestYouTubeInfo(context.url).catch(() => undefined)
  }

  const local = info ? makeVideoResources(info) : []
  const pageUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(info?.id || videoId || "")}`

  // 解析成功 ≠ 能下载：YouTube 对部分视频只放行直链的开头几百 KB，
  // 中段一律 403，从本机地址下就等于是个死链。先探一下中段，取不到就换镜像。
  const probeFormat = info ? pickProbeFormat(info) : undefined
  let localUsable = false
  if (local.length > 0 && probeFormat?.url) {
    statusText.setValue("正在验证视频直链...")
    localUsable = await isDirectlyDownloadable(
      probeFormat.url,
      Number(probeFormat.contentLength),
      headersFor(probeFormat),
    )
    if (localUsable) return { resources: local, title: info?.title || undefined }
  }

  if (videoId && useYouTubeMirror.value) {
    statusText.setValue("正在尝试从第三方镜像获取媒体地址...")
    const mirrored = await buildYouTubeMirrorResources(videoId, info?.title, pageUrl)
    if (mirrored && mirrored.resources.length > 0) {
      statusText.setValue(`已获取 ${mirrored.resources.length} 个候选媒体资源`)
      return { resources: mirrored.resources.map(item => item.type === "video"
        ? { ...item, durationSeconds: item.durationSeconds ?? positiveNumber(info?.duration) }
        : item), title: mirrored.title || info?.title || undefined }
    }
    // 镜像也不通：把“本机地址现在下不动”这件事直接写进条目，别让用户白试
    if (local.length > 0) {
      statusText.setValue("本机直链验证未通过，且第三方镜像暂时不可用；以下资源可能无法下载")
      return {
        resources: local.map(item => ({
          ...item,
          quality: [item.quality, "受限"].filter(Boolean).join(" · "),
        })),
        title: info?.title || undefined,
      }
    }
  }

  return { resources: local, title: info?.title || undefined }
}

export const youtubeParser: SiteParser = {
  id: "youtube",
  matches(url) {
    const host = url.match(/^https?:\/\/([^/:?#]+)/i)?.[1] || ""
    return /(?:^|\.)(?:youtube\.com|youtu\.be)$/i.test(host)
  },
  parse: parseYouTube,
}
