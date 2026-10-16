import type { ResourceItem } from "../types/resource"

/** Metadata only: never fetch a URL or assume an aspect ratio. */
export function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

export function formatDuration(seconds: unknown): string | undefined {
  const value = positiveNumber(seconds)
  if (value === undefined) return undefined
  if (value < 1) return "不足 1 秒"
  const total = Math.floor(value)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const rest = String(total % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`
}

export function videoMetadata(item: ResourceItem): { duration?: string; resolution?: string } {
  if (item.type !== "video") return {}
  const url = item.url.match(/^https?:\/\/([^/?#:]+)(?::\d+)?(\/[^?#]*)?(?:\?([^#]*))?/i)
  const host = (url?.[1] || "").toLowerCase()
  const path = url?.[2] || ""
  // X rendition paths encode the actual width and height, including portrait video.
  const dimensions = host === "video.twimg.com"
    ? path.match(/^\/(?:ext_tw_video|amplify_video|tweet_video)\/.*?\/vid\/(?:avc1\/)?(\d+)x(\d+)\//)
    : null
  const width = positiveNumber(item.width)
  const height = positiveNumber(item.height)
  const urlWidth = positiveNumber(dimensions?.[1])
  const urlHeight = positiveNumber(dimensions?.[2])
  // Prefer a complete metadata pair; do not mix dimensions from different renditions.
  const resolution = width && height ? `${width} × ${height}`
    : urlWidth && urlHeight ? `${urlWidth} × ${urlHeight}`
    : height ? `高度 ${height} px` : width ? `宽度 ${width} px` : undefined
  // googlevideo's dur query parameter is in seconds. Never interpret arbitrary URL numbers.
  const urlDuration = /(?:^|\.)googlevideo\.com$/.test(host)
    ? positiveNumber(url?.[3]?.match(/(?:^|&)dur=(\d+(?:\.\d+)?)(?:&|$)/)?.[1])
    : undefined
  return { duration: formatDuration(positiveNumber(item.durationSeconds) ?? urlDuration), resolution }
}

export function formatVideoSize(bytes: unknown): string | undefined {
  const value = positiveNumber(bytes)
  if (!value) return undefined
  if (value < 1024) return `${Math.round(value)} B`
  const units = ["KB", "MB", "GB", "TB"]
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)) - 1, units.length - 1)
  return `${(value / Math.pow(1024, index + 1)).toFixed(1)} ${units[index]}`
}

export function videoMetadataLabel(item: ResourceItem): string {
  const { duration, resolution } = videoMetadata(item)
  const size = item.type === "video" ? formatVideoSize(item.byteSize) : undefined
  return [duration ? `时长 ${duration}` : undefined, resolution ? `分辨率 ${resolution}` : undefined, size ? `大小 ${size}` : undefined].filter(Boolean).join(" · ")
}
