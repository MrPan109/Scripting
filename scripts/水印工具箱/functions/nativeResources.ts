import { BROWSER_USER_AGENT, MediaItem, extractSupportedURL, parseShareText } from "../parser"
import type { ResourceItem } from "../types/resource"
import { sanitizeFileName } from "../utils/fileName"

/**
 * 把「解析下载」用的本机解析器（小红书/抖音）接进资源提取列表。
 *
 * 这是本工具最强的一条去水印路径：解析器直接读平台自己的公开数据
 * （小红书 fileId 原图 / 抖音官方 play 流），拿到的就是无水印原件，
 * 不需要任何猜测式改写。
 */

/** 判断一段分享文案是否是小红书/抖音作品（不会抛错）。 */
export function isSupportedShareText(input: string): boolean {
  try {
    extractSupportedURL(input.trim())
    return true
  } catch {
    return false
  }
}

/**
 * 按域名判断平台（短链也算）：用于决定走本机解析还是通用提取。
 *
 * 为什么分开：小红书的原图（无 `!` 模板的 fileId 原图）只能从页面数据里拿到，
 * 本机解析最可靠；抖音则相反——图集在分享页数据里就带着无水印原图，
 * 通用提取（站点解析，全程本机）就能拿到，还不用碰受限的第三方接口。
 */
export function sharePlatformOf(input: string): "xiaohongshu" | "douyin" | null {
  let raw = ""
  try {
    raw = extractSupportedURL(input.trim())
  } catch {
    return null
  }
  try {
    const host = new URL(raw).hostname.toLowerCase()
    if (host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com") || host === "xhslink.cn" || host.endsWith(".xhslink.cn")) {
      return "xiaohongshu"
    }
    if (host === "douyin.com" || host.endsWith(".douyin.com") || host.endsWith("iesdouyin.com")) {
      return "douyin"
    }
  } catch {}
  return null
}

function headersFor(source: string): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": BROWSER_USER_AGENT }
  if (source === "douyin") headers.Referer = "https://www.douyin.com/"
  else if (source === "xiaohongshu") headers.Referer = "https://www.xiaohongshu.com/"
  return headers
}

function mediaToResources(media: MediaItem[], title: string, source: string): ResourceItem[] {
  const headers = headersFor(source)
  const used = new Set<string>()
  const items: ResourceItem[] = []

  const uniqueName = (raw: string, index: number) => {
    const fallback = `${source}_${index + 1}`
    let name = sanitizeFileName(raw, fallback)
    if (!name || used.has(name)) {
      const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : ""
      name = `${fallback}${ext}`
    }
    let suffix = 2
    const base = name
    while (used.has(name)) {
      const ext = base.includes(".") ? base.slice(base.lastIndexOf(".")) : ""
      name = `${base.replace(/\.[^.]*$/, "")}_${suffix}${ext}`
      suffix += 1
    }
    used.add(name)
    return name
  }

  media.forEach((item, index) => {
    const safeTitle = sanitizeFileName(title, source)
    if (item.kind === "livePhoto") {
      // 实况照片 = 静帧图 + 动态片段，两个都能单独保存
      const stillURL = item.stillUrl ?? item.previewUrl
      if (stillURL) {
        items.push({
          type: "image",
          url: stillURL,
          name: uniqueName(`${safeTitle}_${index + 1}_静图.jpg`, index),
          source,
          quality: "来源媒体",
          watermarkFree: true,
          watermarkFreeUrl: stillURL,
          headers,
        })
      }
      items.push({
        type: "video",
        url: item.url,
        name: uniqueName(`${safeTitle}_${index + 1}_实况.mp4`, index),
        source,
        quality: "来源媒体",
        watermarkFree: true,
        watermarkFreeUrl: item.url,
        headers,
      })
      return
    }

    const type: ResourceItem["type"] = item.kind === "video" ? "video" : item.kind === "audio" ? "audio" : "image"
    const preferred = type === "video" ? `${safeTitle}_${index + 1}.mp4` : item.fileName
    items.push({
      type,
      url: item.url,
      name: uniqueName(preferred, index),
      source,
      quality: "来源媒体",
      watermarkFree: true,
      watermarkFreeUrl: item.url,
      alternateUrls: item.alternateUrls,
      headers,
    })
    if (item.previewUrl && item.previewUrl !== item.url && type === "video") {
      items.push({
        type: "image",
        url: item.previewUrl,
        name: uniqueName(`${safeTitle}_${index + 1}_封面.jpg`, index),
        source,
        likelyThumbnail: true,
        headers,
      })
    }
  })

  return items
}

export interface NativeResourceResult {
  items: ResourceItem[]
  title: string
  notice: string
}

/**
 * 用本机解析器取出无水印媒体。输入不是小红书/抖音作品时返回 null。
 * 解析失败会抛出原始错误，由调用方决定是否退回通用提取。
 */
export async function extractNativeResources(input: string): Promise<NativeResourceResult | null> {
  if (!isSupportedShareText(input)) return null
  const result = await parseShareText(input)
  const items = mediaToResources(result.media, result.title, result.platform)
  if (items.length === 0) return null
  const platformName = result.platform === "xiaohongshu" ? "来源页面" : "来源页面"
  return {
    items,
    title: result.title,
    notice: `已提取${platformName}中的媒体；解析优先在本机进行，回退时会将作品链接提交至第三方明文 HTTP 服务。`,
  }
}
