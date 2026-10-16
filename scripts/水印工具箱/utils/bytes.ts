/** 把字节数写成 523MB / 3.0GB 这样的短标签；未知返回空串，方便直接拼进说明文字。 */
export function formatByteSize(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return ""

  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const text = value >= 10 || unitIndex === 0 ? Math.round(value).toString() : value.toFixed(1)
  return `${text}${units[unitIndex]}`
}
