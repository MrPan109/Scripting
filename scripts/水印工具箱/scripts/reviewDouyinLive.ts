import { Script } from "scripting"
import { resourcesFromDouyinData } from "../services/parsers/douyin"
import { resourcesToParseResult } from "../functions/workParse"
const context = { url: "https://www.douyin.com/note/1", html: "" }
const image = (size: number) => ({ url_list: [`https://example.com/still~tplv-dy:${size}:${size}.jpeg`] })
const video = { duration: 3200, play_addr: { url_list: ["https://example.com/motion.mp4"] } }
const items = resourcesFromDouyinData([
  { images: [image(1080)] },
  { images: [{ ...image(640), video }] },
], context)
const mapped = resourcesToParseResult(items, "fixture", context.url)
const partial = resourcesFromDouyinData({ images: [
  { ...image(1080), video: {} , live_photo: video },
] }, context)
const variants = resourcesFromDouyinData({ images: [{ ...image(1080), video: {
  duration: 3200,
  play_addr: { url_list: ["https://example.com/low.mp4"], width: 640, height: 800 },
  download_addr: { url_list: ["https://example.com/watermarked.mp4"] },
  bit_rate: [{ play_addr: { url_list: ["https://example.com/high.mp4", "https://example.com/high-backup.mp4"], width: 1080, height: 1350 } }],
} }] }, context)
const picked = variants.find(item => item.livePhotoUrl)
if (picked?.livePhotoUrl !== "https://example.com/high.mp4" || picked.livePhotoAlternateUrls?.length !== 1
  || picked.livePhotoAlternateUrls[0] !== "https://example.com/high-backup.mp4") throw new Error("动态版本混入备用线路")
const falseMotion = resourcesFromDouyinData({ images: [{ ...image(1080), video: { url: "https://example.com/still.jpg" } }] }, context)
if (falseMotion.some(item => item.livePhotoUrl)) throw new Error("静图被误判为动态")
if (items.length !== 1 || partial.filter(item => item.livePhotoUrl).length !== 1) throw new Error("原有配对回归")
Script.exit({
  variantIsolation: true,
  rejectStillAsMotion: true,
  crossSourceSameImage: { expectedCount: 1, actualCount: items.length, kinds: mapped?.media.map(item => item.kind) },
  emptyFirstMotionAlias: { expectedLiveCount: 1, actualLiveCount: partial.filter(item => item.livePhotoUrl).length },
})
