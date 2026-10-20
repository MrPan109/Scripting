import { Script } from "scripting"
import { resourcesFromDouyinData } from "../services/parsers/douyin"
import { resourcesToParseResult } from "../functions/workParse"

let checks = 0
function check(value: boolean, message: string) { if (!value) throw new Error(message); checks++ }

const still = (name: string) => ({
  url_list: [`https://p3.douyinpic.com/${name}~tplv-dy:640:800.jpeg`, `https://p3.douyinpic.com/${name}~tplv-dy:1080:1350.jpeg`],
  width: 1080,
  height: 1350,
})
const motion = (name: string) => ({
  duration: 3200,
  width: 1080,
  height: 1350,
  play_addr: { url_list: [`https://v3.douyinvod.com/${name}.mp4`, `https://v9.douyinvod.com/${name}.mp4`] },
})
const root = {
  aweme_detail: {
    desc: "实况图文",
    image_post_info: {
      images: [
        { ...still("live-a"), video: motion("live-a") },
        still("still-b"),
        { ...still("live-c"), live_photo: { duration: 2100, play_addr: { url_list: ["https://v3.douyinvod.com/live-c.mp4"] } } },
      ],
    },
  },
}

const items = resourcesFromDouyinData(root, { url: "https://www.douyin.com/note/1", html: "" })
const images = items.filter(item => item.type === "image")
check(images.length === 3, "三张图各保留一条")
check(images.filter(item => item.livePhotoUrl).length === 2, "两张实况图识别成功")
check(items.filter(item => item.type === "video").length === 0, "实况动态不另列成视频")
check(images[0].livePhotoUrl === "https://v3.douyinvod.com/live-a.mp4", "首选动态地址")
check(images[0].livePhotoAlternateUrls?.length === 1, "动态备用地址合并")
check(images[0].livePhotoDurationSeconds === 3.2, "毫秒时长转秒")
check(images[0].url.includes("1080:1350"), "静图保留最大尺寸")
check(images[1].livePhotoUrl === undefined, "普通静态图不受影响")

const result = resourcesToParseResult(items, "实况图文", "https://www.douyin.com/note/1")
check(Boolean(result), "图文映射成功")
const media = result!.media
check(media.filter(item => item.kind === "livePhoto").length === 2, "作品页显示两条实况")
const live = media.find(item => item.kind === "livePhoto")!
check(live.url === "https://v3.douyinvod.com/live-a.mp4", "动态片段作为实况主地址")
check(Boolean(live.stillUrl?.includes("1080:1350")), "静图地址保留供另存")
check(live.durationMs === 3200, "实况时长保留")
check(live.fileName.endsWith(".mp4"), "实况文件名正确")
check(media.filter(item => item.kind === "image").length === 1, "静态图只保留一条")

// 有些详情把图片放在 aweme_detail.images；同一实况图重复出现时不应重复成两条。
const directItems = resourcesFromDouyinData({
  aweme_detail: {
    images: [
      { ...still("same"), video: motion("same") },
      { ...still("same"), video: motion("same") },
      { ...still("no-motion"), video: { duration: 1000, play_addr: { url_list: [] } } },
    ],
  },
}, { url: "https://www.douyin.com/note/3", html: "" })
check(directItems.filter(item => item.type === "image").length === 2, "重复实况图合并且普通图保留")
check(directItems.filter(item => item.livePhotoUrl).length === 1, "无动态地址的图片不标记实况")

// 回归：普通视频作品的视频流仍按视频资源输出。
const videoItems = resourcesFromDouyinData({
  aweme_detail: {
    desc: "普通视频",
    video: {
      duration: 8000,
      play_addr: { url_list: ["https://v3.douyinvod.com/normal.mp4"], width: 1080, height: 1920 },
    },
  },
}, { url: "https://www.douyin.com/video/2", html: "" })
check(videoItems.filter(item => item.type === "video").length === 1, "普通视频仍保留")
check(videoItems.every(item => item.livePhotoUrl === undefined), "普通视频不标记实况")

Script.exit({ ok: true, checks })
