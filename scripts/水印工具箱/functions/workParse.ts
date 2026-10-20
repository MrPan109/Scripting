import { fetch } from "scripting"
import {
  BROWSER_USER_AGENT,
  MediaItem,
  ParseResult,
  detectPlatform,
  expandShortLink,
  extractSupportedURL,
  parseDouyinVideoLocally,
  parseShareText,
} from "../parser"
import { parseSiteResources } from "../services/parsers"
import type { ResourceItem } from "../types/resource"
import { sanitizeFileName } from "../utils/fileName"

/**
 * 统一的作品解析入口（合并「解析下载」与「资源提取」后由同一个输入框调用）。
 *
 * 分流原则：能本机拿到的绝不用第三方。
 *  - 小红书：本机解析器（页面数据里的 fileId 原图 + 实况动态 + 视频）
 *  - 抖音视频：本机 WebView 取官方 play 流（优先读取来源画质）
 *  - 抖音图文：本机站点解析（页内数据里的无水印原图 + 背景音乐），不再依赖第三方
 *  - 以上都不行时才回退第三方接口
 */

function platformOf(input: string): "xiaohongshu" | "douyin" | null {
  try {
    return detectPlatform(extractSupportedURL(input.trim()))
  } catch {
    return null
  }
}

/** 这段文案是否是小红书/抖音作品（不会抛错）。 */
export function isWorkInput(input: string): boolean {
  return platformOf(input) !== null
}

function ensureExtension(name: string, fallback: string): string {
  const safe = sanitizeFileName(name, `media.${fallback}`)
  return /\.[a-z0-9]{2,5}$/i.test(safe) ? safe : `${safe}.${fallback}`
}

/**
 * 把网页资源提取的结果（抖音站点解析）转成作品媒体列表，
 * 这样图文作品、视频作品在界面上长得一样，都能用「保存到相册 / 导出文件」。
 */
function resourcesToParseResult(items: ResourceItem[], title: string, sourceUrl: string): ParseResult | null {
  const videos = items.filter(item => item.type === "video")
  const audios = items.filter(item => item.type === "audio")
  const mainImages = items.filter(item => item.type === "image" && !item.likelyThumbnail)
  const covers = items.filter(item => item.type === "image" && item.likelyThumbnail)
  const coverUrl = covers[0]?.url ?? mainImages[0]?.url

  const media: MediaItem[] = []

  videos.forEach((item, index) => {
    media.push({
      id: `video-${index}`,
      kind: "video",
      label: videos.length > 1 ? `视频 ${index + 1}` : "视频",
      url: item.url,
      alternateUrls: item.alternateUrls,
      quality: item.quality,
      // 站点数据可能含多个视频；只沿用解析器明确给出的同视频分组。
      qualityGroup: item.qualityGroup,
      width: item.width,
      height: item.height,
      byteSize: item.byteSize,
      durationSeconds: item.durationSeconds,
      previewUrl: coverUrl,
      fileName: ensureExtension(item.name, "mp4"),
    })
  })

  mainImages.forEach((item, index) => {
    media.push({
      id: `image-${index}`,
      kind: "image",
      label: mainImages.length > 1 ? `图片 ${index + 1}` : "图片",
      url: item.url,
      alternateUrls: item.alternateUrls,
      previewUrl: item.url,
      fileName: ensureExtension(item.name, "jpg"),
    })
  })

  audios.forEach((item, index) => {
    media.push({
      id: `audio-${index}`,
      kind: "audio",
      label: audios.length > 1 ? `背景音乐 ${index + 1}` : "背景音乐",
      url: item.url,
      previewUrl: item.url,
      fileName: ensureExtension(item.name, "mp3"),
    })
  })

  // 视频封面只在与媒体不重复时单独列出（沿用原来「解析下载」的信息量）
  if (videos.length > 0 && covers[0]) {
    media.push({
      id: "cover",
      kind: "image",
      label: "视频封面",
      url: covers[0].url,
      previewUrl: covers[0].url,
      fileName: ensureExtension(covers[0].name, "jpg"),
    })
  }

  if (media.length === 0) return null

  return {
    platform: "douyin",
    title: title.trim() || "来源作品",
    sourceUrl,
    media,
    privacyNotice: "本机解析：读取来源页面的公开媒体数据，未使用第三方服务；实际内容以下载结果为准。",
  }
}

/** 抖音图文：短链展开 → 抓页面 → 站点解析（全程本机）。 */
async function parseDouyinGalleryLocally(input: string, resolvedURL?: string): Promise<ParseResult | null> {
  const resolved = resolvedURL || await expandShortLink(extractSupportedURL(input.trim()))
  if (detectPlatform(resolved) !== "douyin") return null

  const response = await fetch(resolved, {
    headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    timeout: 30,
  })
  if (!response.ok) return null
  const pageURL = response.url || resolved
  const html = await response.text()

  // 站点解析内部会在页面 HTML 没有数据时用 WebView 兜底，所以这里直接调它
  const site = await parseSiteResources({ url: pageURL, html })
  if (!site.resources || site.resources.length === 0) return null

  const rawTitle = site.title ?? ""
  const title = rawTitle.replace(/\s*[-_]?\s*抖音\s*$/i, "").trim()
  return resourcesToParseResult(site.resources, title, pageURL)
}

/** 抖音图文作品（note/gallery/slides）不适合先试视频解析，白等十几秒。 */
function isGalleryLikeDouyinURL(url: string): boolean {
  try {
    return /(?:^|\/)(?:note|gallery|slides)\//i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

/** 作品解析总入口：按平台挑最本机的路径。 */
export async function parseWork(input: string): Promise<ParseResult> {
  const platform = platformOf(input)
  if (!platform) throw new Error("没有找到受支持的作品链接")

  if (platform === "xiaohongshu") {
    // 小红书：本机解析器（原图 fileId、实况动态、视频）最干净
    return await parseShareText(input)
  }

  // 抖音：先看清是不是图文（短链也要展开才知道），图文直接走站点解析，
  // 不再白等一轮拿不到 video_id 的 WebView 视频解析。
  const resolvedURL = await expandShortLink(extractSupportedURL(input.trim())).catch(() => "")
  const galleryFirst = resolvedURL ? isGalleryLikeDouyinURL(resolvedURL) : false

  if (!galleryFirst) {
    // 视频：本机 WebView 优先保留来源提供的画质列表，缺失时沿用官方播放端点。
    const localVideo = await parseDouyinVideoLocally(input).catch(() => null)
    if (localVideo) return localVideo
  }

  // 图文/图集：页内数据里的无水印原图 + 背景音乐
  const gallery = await parseDouyinGalleryLocally(input, resolvedURL || undefined).catch(() => null)
  if (gallery) return gallery

  // 本机两条路都没拿到，才回退第三方接口
  return await parseShareText(input)
}
