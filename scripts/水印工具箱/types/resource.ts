import { sanitizeFileName } from "../utils/fileName"

export interface ResourceItem {
  type: "image" | "css" | "js" | "video" | "audio" | "font" | "document" | "archive" | "other"
  url: string
  name: string
  likelyThumbnail?: boolean
  source?: string
  quality?: string
  /** 仅在来源数据明确属于同一视频时设置，不能按页面统一分组。 */
  qualityGroup?: string
  /** 来源视频版本必须保留其 URL，不做统一无水印地址换算。 */
  preserveSourceVariant?: boolean
  /** 图文作品的实况图片：动态片段地址；有值时同一静图可另存为实况照片。 */
  livePhotoUrl?: string
  /** 实况动态的备用地址 */
  livePhotoAlternateUrls?: string[]
  /** 实况动态时长（秒）；来源未提供时省略。 */
  livePhotoDurationSeconds?: number
  format?: string
  /** 视频时长，单位秒；未知时省略。 */
  durationSeconds?: number
  width?: number
  height?: number
  audioUrl?: string
  headers?: Record<string, string>
  sourceUrl?: string
  videoFormatId?: string
  audioFormatId?: string
  /** 视频轨预估字节数（体积显示 / 下载进度用） */
  byteSize?: number
  /** 音轨预估字节数 */
  audioByteSize?: number
  /** 已探测确认可用的无水印地址（有值时它就是换算后的 url） */
  watermarkFree?: boolean
  /** 上述无水印地址，供手动拷贝原图/备用下载 */
  watermarkFreeUrl?: string
  /** 无水印地址不可用时可回退的原地址 */
  originalUrl?: string
  /** 平台自带的其他备用地址（下载失败时依次重试） */
  alternateUrls?: string[]
}

export { sanitizeFileName }

export const CATEGORY_ORDER: ResourceItem["type"][] = [
  "image", "video", "audio", "document", "archive", "css", "js", "font", "other"
]

export type M3u8Segment = {
  url: string
  keyUrl: string | null
  keyMethod: string | null  // "AES-128" | null
  ivHex: string | null
  seq: number
}
