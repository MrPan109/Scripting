import { fetch } from "scripting"
import type { ResourceItem } from "../types/resource"

/**
 * 去水印（提取侧）
 *
 * 说明：真正意义上的「去掉画面上的水印」需要重新编码，本机做不到也不可靠。
 * 抖音/小红书这类平台会给同一份媒体提供「带水印」和「无水印」两套官方地址，
 * 这里做的是**换成无水印的那一套官方源**：
 *
 *  - 抖音视频：`/aweme/v1/playwm/`（playwm = play with watermark）换成官方
 *    `/aweme/v1/play/`，同一个 video_id，拿到的是无水印片源。
 *  - 小红书图片：`sns-webpic-*` 上带 `!模板` 的地址是 Web 压缩/水印版，
 *    原图在 `sns-img-bd.xhscdn.com/<fileId>`（无 `!` 后缀）。
 *
 * 任何换算结果都会先实际请求校验（HTTP 200 且是图片/视频），
 * 校验不通过就保留原地址 —— 宁可不去水印，也不能把能用的资源换成 403。
 */

const DOUYIN_PLAYWM_PATH = /\/aweme\/v1\/playwm\/?/
const XHS_WEBPIC_HOST = /^sns-webpic[\w-]*\.xhscdn\.com$/i
const XHS_ORIGIN_HOST = "sns-img-bd.xhscdn.com"
/** 小红书 webpic 地址末尾的 `!nd_dft_wlteh_webp_3` 这类模板后缀 */
const XHS_TEMPLATE_SUFFIX = /![^/]*$/
/** 看起来像时间戳/签名目录的路径段（换原图时要丢掉） */
const XHS_TOKEN_SEGMENT = /^(?:\d{8,}|[0-9a-f]{16,})$/i

function isDouyinHost(host: string): boolean {
  return host === "douyin.com" || host.endsWith(".douyin.com")
    || host.endsWith("snssdk.com") || host.endsWith("amemv.com")
}

/**
 * 给出该地址的「无水印官方源」候选；没有可靠换算时返回 null。
 * 只做地址换算，不做任何网络请求。
 */
export function watermarkFreeCandidate(rawURL: string): string | null {
  let url: URL
  try {
    url = new URL(rawURL)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase()

  // ── 抖音：playwm → play ────────────────────────────────────────────────
  if (isDouyinHost(host) && DOUYIN_PLAYWM_PATH.test(url.pathname)) {
    const videoId = url.searchParams.get("video_id")
    // 只有 aweme.snssdk.com 的 play 端点稳定可用；m.douyin.com 的 play 是 404。
    if (videoId && /^[A-Za-z0-9_-]+$/.test(videoId)) {
      return `https://aweme.snssdk.com/aweme/v1/play/?video_id=${videoId}&ratio=1080p`
    }
    return null
  }

  // ── 小红书：sns-webpic 模板版 → sns-img-bd 原图 ────────────────────────
  if (XHS_WEBPIC_HOST.test(host)) {
    const withoutTemplate = url.pathname.replace(XHS_TEMPLATE_SUFFIX, "")
    const segments = withoutTemplate.split("/").filter(Boolean)
    // 丢掉开头的时间戳/签名目录，剩下的就是 fileId（可能自带 notes_pre_post/ 这类前缀）
    while (segments.length > 1 && XHS_TOKEN_SEGMENT.test(segments[0])) segments.shift()
    const fileId = segments.join("/")
    if (fileId.length >= 16 && /^[A-Za-z0-9_/-]+$/.test(fileId)) {
      return `https://${XHS_ORIGIN_HOST}/${fileId}`
    }
  }

  return null
}

const PROBE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
  Accept: "image/*,video/*,audio/*,*/*",
}

function compatibleContentType(contentType: string): boolean {
  if (!contentType) return false
  return /^(image|video|audio)\//i.test(contentType) || contentType.includes("octet-stream")
}

/** 实际请求一次，确认这个无水印地址真的能取到媒体。 */
export async function verifyMediaURL(url: string, referer?: string): Promise<boolean> {
  const headers: Record<string, string> = { ...PROBE_HEADERS }
  if (referer) headers.Referer = referer
  try {
    const response = await fetch(url, {
      headers: { ...headers, Range: "bytes=0-63" },
      timeout: 8000,
      allowInsecureRequest: true,
    })
    if (!response.ok && response.status !== 206) return false
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
    if (contentType.includes("text/html")) return false
    return compatibleContentType(contentType)
  } catch {
    return false
  }
}

export interface WatermarkFreeOutcome {
  items: ResourceItem[]
  /** 成功换成无水印源的条目数 */
  replaced: number
}

/**
 * 对已提取到的资源批量尝试换算无水印源。
 * 只有探测通过才会替换 `url`，原始地址保留在 `originalUrl` 里。
 * `verify` 可注入，便于测试时不开网络。
 */
export async function applyWatermarkFree(
  items: ResourceItem[],
  referer: string,
  onProgress?: (completed: number, total: number) => void,
  verify: (url: string, referer?: string) => Promise<boolean> = verifyMediaURL,
): Promise<WatermarkFreeOutcome> {
  const candidates: { index: number; free: string }[] = []
  items.forEach((item, index) => {
    if (item.type !== "image" && item.type !== "video" && item.type !== "audio") return
    if (item.type === "video" && item.preserveSourceVariant) return
    const free = watermarkFreeCandidate(item.url)
    if (free && free !== item.url) candidates.push({ index, free })
  })

  if (candidates.length === 0) return { items, replaced: 0 }

  const CONCURRENCY_LIMIT = 8
  const next = items.slice()
  let replaced = 0
  let completed = 0

  for (let i = 0; i < candidates.length; i += CONCURRENCY_LIMIT) {
    const chunk = candidates.slice(i, i + CONCURRENCY_LIMIT)
    const results = await Promise.all(chunk.map(async candidate => {
      const ok = await verify(candidate.free, referer)
      return { ...candidate, ok }
    }))
    for (const result of results) {
      if (!result.ok) continue
      const original = next[result.index]
      next[result.index] = {
        ...original,
        url: result.free,
        watermarkFreeUrl: result.free,
        watermarkFree: true,
        originalUrl: original.originalUrl ?? original.url,
      }
      replaced += 1
    }
    completed += chunk.length
    onProgress?.(Math.min(completed, candidates.length), candidates.length)
  }

  return { items: next, replaced }
}
