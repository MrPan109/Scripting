export function douyinWorkId(url: string): string | undefined {
  return url.match(/\/(?:share\/)?(?:video|note|gallery|slides)\/(\d{15,20})(?:[/?#]|$)/)?.[1]
    ?? url.match(/[?&](?:modal_id|aweme_id|item_id)=(\d{15,20})(?:[&#]|$)/)?.[1]
}

/** 仅返回目标作品自己的媒体字段，不递归采集推荐、作者或评论中的媒体。 */
export function douyinOwnedData(root: unknown, target: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  const seen = new Set<object>()
  let count = 0
  function walk(value: unknown, depth: number) {
    if (!value || typeof value !== 'object' || depth > 22 || seen.has(value) || count++ > 30000) return
    seen.add(value)
    if (Array.isArray(value)) { value.forEach(item => walk(item, depth + 1)); return }
    const record = value as Record<string, unknown>
    const id = record.aweme_id ?? record.awemeId ?? record.item_id ?? record.itemId
    if (id !== undefined) {
      // 数字 ID 可能已丢精度，不猜测归属。
      if (typeof id !== 'string' || id !== target) return
      // 移动页 itemId / aweme_id 也会出现在纯路由容器上。
      // 只有媒体结构才结束搜索；向下搜索不继承 ID，避免接收未知归属媒体。
      const hasMedia = (record.video !== null && typeof record.video === 'object' && !Array.isArray(record.video) && Object.keys(record.video).length > 0)
        || (Array.isArray(record.images) && record.images.length > 0)
        || ['image_post_info', 'imagePostInfo'].some(key => {
          const post = record[key]
          const images = post !== null && typeof post === 'object' ? (post as Record<string, unknown>).images : undefined
          return Array.isArray(images) && images.length > 0
        })
      if (hasMedia) {
        const owned: Record<string, unknown> = {}
        for (const key of ['desc', 'description', 'title', 'video', 'images', 'image_post_info', 'imagePostInfo']) {
          if (record[key] !== undefined) owned[key] = record[key]
        }
        result.push(owned)
        return
      }
    }
    Object.values(record).forEach(item => walk(item, depth + 1))
  }
  walk(root, 0)
  return result
}
