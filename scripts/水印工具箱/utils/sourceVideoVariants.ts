export interface SourceVideoVariant {
  url: string
  alternateUrls?: string[]
  quality: string
  width?: number
  height?: number
  byteSize?: number
  durationSeconds?: number
}

function positive(value: unknown): number | undefined {
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function urls(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string")
    .map(value => value.replace(/^http:\/\//i, "https://"))
    .filter(value => { try { return new URL(value).protocol === "https:" } catch { return false } }))]
}

function label(width?: number, height?: number, bitrate?: number, codec?: string): string {
  return [width && height ? `${width} × ${height}` : height ? `${height}p` : "来源画质（分辨率未知）",
    bitrate ? `${Math.round(bitrate / 1000)} kbps` : undefined, codec || undefined].filter(Boolean).join(" · ")
}

// 仅按实际 URL 合并重复记录；同一流的 CDN 备份不成为另一档画质。
function append(target: SourceVideoVariant[], variant: SourceVideoVariant) {
  const addresses = [variant.url, ...(variant.alternateUrls ?? [])]
  const existing = target.find(item => [item.url, ...(item.alternateUrls ?? [])].some(url => addresses.includes(url)))
  if (existing) {
    existing.alternateUrls = [...new Set([...(existing.alternateUrls ?? []), ...addresses])].filter(url => url !== existing.url)
    for (const key of ["width", "height", "byteSize", "durationSeconds"] as const) {
      if (existing[key] === undefined && variant[key] !== undefined) existing[key] = variant[key]
    }
    if (existing.quality.includes("未知") && variant.width && variant.height) existing.quality = variant.quality
  } else target.push(variant)
}

export function xhsVideoVariants(note: any): SourceVideoVariant[] {
  const result: SourceVideoVariant[] = []
  const origin = note?.video?.consumer?.originVideoKey
  if (typeof origin === "string" && origin) {
    const [url] = urls([`https://sns-video-bd.xhscdn.com/${origin.replace(/^\/+/, "")}`])
    if (url) result.push({ url, quality: "原始来源（分辨率未知）" })
  }
  const groups = note?.video?.media?.stream
  if (!groups || typeof groups !== "object") return result
  for (const [codec, streams] of Object.entries(groups)) {
    if (!Array.isArray(streams)) continue
    for (const stream of streams) {
      const addresses = urls([stream?.masterUrl, ...(Array.isArray(stream?.backupUrls) ? stream.backupUrls : [])])
      if (!addresses.length) continue
      const width = positive(stream.width), height = positive(stream.height)
      const duration = positive(stream.duration)
      append(result, { url: addresses[0], alternateUrls: addresses.slice(1), width, height,
        byteSize: positive(stream.size), durationSeconds: duration ? duration / 1000 : undefined,
        quality: label(width, height, positive(stream.videoBitrate ?? stream.avgBitrate ?? stream.bitrate), String(stream.videoCodec ?? codec)) })
    }
  }
  return result.sort((a, b) => {
    if (a.quality.startsWith("原始来源")) return -1
    if (b.quality.startsWith("原始来源")) return 1
    return (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0) || (b.byteSize ?? 0) - (a.byteSize ?? 0)
  })
}

export function douyinVideoVariants(video: any): SourceVideoVariant[] {
  const result: SourceVideoVariant[] = []
  if (!video || typeof video !== "object") return result
  const rates = Array.isArray(video.bit_rate) ? video.bit_rate : Array.isArray(video.bitRate) ? video.bitRate : Array.isArray(video.bitRateList) ? video.bitRateList : []
  const entries = [...rates, video]
  for (const entry of entries) {
    for (const key of ["play_addr", "play_addr_h264", "play_addr_265", "playAddr", "playAddrH265"]) {
      const address = entry?.[key]
      if (!address) continue
      // 桌面 SSR 的数组只表示当前条目/编码的 CDN 线路，不跨码率收集备用。
      const desktop = Array.isArray(address)
      const addresses = urls(desktop ? address.map(item => item?.src) : [
        ...(Array.isArray(address.url_list) ? address.url_list : []),
        ...(Array.isArray(address.urlList) ? address.urlList : []), address.url,
      ])
      if (!addresses.length) continue
      const width = positive(address.width ?? entry.width), height = positive(address.height ?? entry.height)
      const duration = positive(entry.duration ?? video.duration)
      append(result, { url: addresses[0], alternateUrls: addresses.slice(1), width, height,
        byteSize: positive(desktop ? entry.dataSize : address.data_size ?? address.dataSize), durationSeconds: duration ? duration / 1000 : undefined,
        quality: label(width, height, positive(entry.bit_rate ?? entry.bitRate), key.includes("264") ? "H.264" : key.includes("265") ? "H.265" : undefined) })
    }
  }
  return result.sort((a, b) => {
    if (a.quality.startsWith("原始来源")) return -1
    if (b.quality.startsWith("原始来源")) return 1
    return (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0) || (b.byteSize ?? 0) - (a.byteSize ?? 0)
  })
}
