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

const videoWithURL = resourcesFromDouyinData({ video: {
  url: "https://v3.douyinvod.com/normal.mp4",
  play_addr: { url_list: ["https://v3.douyinvod.com/normal.mp4"] },
}}, { url: "https://www.douyin.com/video/2", html: "" })
check(videoWithURL.some(item => item.type === "video"), "带 url 的普通视频不能被吞掉")
check(videoWithURL.every(item => !item.livePhotoUrl), "普通视频 url 不构成静图配对")
const musicImage = resourcesFromDouyinData({ images: [{ ...still("music-only"), video: {
  play_addr: { url_list: ["https://example.com/ies-music/background.mp3"] },
}}]}, { url: "https://www.douyin.com/note/3", html: "" })
check(musicImage.some(item => item.type === "image"), "背景音乐图片仍保留静图")
check(musicImage.every(item => !item.livePhotoUrl), "背景音乐不能作为实况动态")

// 真实缺陷的脱敏结构：同一无扩展名音乐既在播放包装参数中，也在 uri 中。
const musicURL = "https://sf11-cdn-tos.douyinstatic.com/public-audio"
const galleryMusic = resourcesFromDouyinData({ video: {
  play_addr: { uri: musicURL, url_list: [`https://aweme.snssdk.com/aweme/v1/playwm/?video_id=${encodeURIComponent(musicURL)}&ratio=720p`] },
}, images: [still("gallery")] }, { url: "https://www.douyin.com/note/3", html: "" })
check(galleryMusic.filter(item => item.type === "audio").length === 1, "包装地址与 uri 中的背景音乐只输出一条")
check(galleryMusic.every(item => item.type !== "video"), "无扩展名背景音乐不重复列为视频")
check(resourcesToParseResult(galleryMusic, "图文", "https://www.douyin.com/note/3")!.media.every(item => item.kind !== "video" && item.kind !== "livePhoto"), "图文音乐不能提供视频转实况入口")
const maskedMotion = resourcesFromDouyinData({ images: [{ ...still("paired"),
  video: { url: "https://p3.douyinpic.com/still~tplv-resize:640:800" },
  live_photo: motion("real-motion"),
}] }, { url: "https://www.douyin.com/note/3", html: "" })
check(maskedMotion[0].livePhotoUrl === "https://v3.douyinvod.com/real-motion.mp4", "无扩展名静图不遮蔽后续有效动态")
const unknownMotion = resourcesFromDouyinData({ images: [{ ...still("unknown"),
  video: { url: "https://example.com/unknown" },
}] }, { url: "https://www.douyin.com/note/3", html: "" })
check(unknownMotion.every(item => !item.livePhotoUrl), "未知通用 URL 不直接标为实况")
const extensionlessVideo = resourcesFromDouyinData({ video: { play_addr: { url_list: ["https://example.com/video-stream"] } } }, { url: "https://www.douyin.com/video/2", html: "" })
check(extensionlessVideo.some(item => item.type === "video"), "明确播放字段中的普通无扩展名视频保留")
// 桌面弹层的真实字段形状（脱敏）：明确作品身份 + images[].video.playAddr[].src。
const desktopId = "76" + "000000000000003"
const desktopLive = resourcesFromDouyinData({ awemeId: desktopId, images: [{
  urlList: ["https://p3.douyinpic.com/desktop~tplv-dy:2160:3840.webp"], livePhotoType: 1, clipType: 5,
  video: { duration: 3667, width: 720, height: 1280, playAddr: [{ src: "https://v3.douyinvod.com/desktop-stream" }, { src: "https://v9.douyinvod.com/desktop-stream" }],
    bitRateList: [{ width: 720, height: 1280, dataSize: 777887, playAddr: [{ src: "https://v3.douyinvod.com/desktop-stream" }, { src: "https://v9.douyinvod.com/desktop-stream" }] }] },
}] }, { url: `https://www.douyin.com/note/${desktopId}`, html: "" })
check(desktopLive.filter(item => item.livePhotoUrl).length === 1, "绑定目标身份的桌面图片动态识别")
check(desktopLive[0].livePhotoAlternateUrls?.length === 1, "桌面动态只保留当前流的备用线路")
check(Math.round((desktopLive[0].livePhotoDurationSeconds ?? 0) * 1000) === 3667, "桌面动态毫秒时长保留")
check(resourcesToParseResult(desktopLive, "fixture", `https://www.douyin.com/note/${desktopId}`)?.media[0].kind === "livePhoto", "桌面动态映射到实况保存出口")
Script.exit({ ok: true, checks })
