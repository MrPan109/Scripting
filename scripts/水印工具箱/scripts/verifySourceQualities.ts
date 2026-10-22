import { Script } from "scripting"
import { xhsVideoVariants, douyinVideoVariants } from "../utils/sourceVideoVariants"

let checks = 0
function check(value: boolean, message: string) { if (!value) throw new Error(message); checks++ }
const stream = (name: string, height: number) => ({ masterUrl: `https://example.com/${name}`, backupUrls: [`https://backup.example.com/${name}`], width: height * 16 / 9, height, size: height * 100, duration: 5000 })
const single = xhsVideoVariants({ video: { media: { stream: { h264: [stream("one", 720)] } } } })
check(single.length === 1, "单画质只一项")
check(single[0].alternateUrls?.length === 1, "备份不另列")
check(single[0].durationSeconds === 5, "毫秒时长转秒")
const multi = xhsVideoVariants({ video: { consumer: { originVideoKey: "original" }, media: { stream: { h264: [stream("a", 720), stream("b", 1080)], h265: [stream("c", 1080)] } } } })
check(multi.length === 4, "原始和多个转码流均保留")
check(multi[0].width === undefined, "不借用其他流尺寸")
check(multi[1].height === 1080, "转码列表优先高画质")
const dupe = xhsVideoVariants({ video: { media: { stream: { h264: [stream("one", 720), stream("one", 720)] } } } })
check(dupe.length === 1, "重复流合并")
const addr = (name: string, height: number) => ({ url_list: [`https://example.com/${name}`, `https://backup.example.com/${name}`], width: 720, height, data_size: 1234 })
const dy = douyinVideoVariants({ duration: 9000, play_addr: addr("a", 1280), bit_rate: [{ play_addr: addr("a", 1280), bit_rate: 1000000 }, { play_addr: addr("b", 1920), bit_rate: 2000000 }] })
check(dy.length === 2, "抖音保留两档并合并默认地址")
check(dy[0].height === 1920 && dy[0].byteSize === 1234, "对应尺寸与大小")
check(dy.every(item => item.alternateUrls?.length === 1), "抖音备份归组")
check(dy.every(item => item.durationSeconds === 9), "抖音时长继承")
check(douyinVideoVariants({ play_addr: addr("single", 1280) }).length === 1, "抖音单流")
check(douyinVideoVariants({ bit_rate: [null, {}], play_addr: addr("fallback", 1280) }).length === 1, "无效码率条目不阻断默认流")
check(xhsVideoVariants({ video: { media: { stream: { h264: [null, { masterUrl: "javascript:alert(1)" }] } } } }).length === 0, "无效地址不进入选择列表")
// 脱敏桌面 SSR 结构：仅使用保留示例域名，不读取或请求真实媒体。
const desktopAddr = (name: string) => [
  { src: `https://example.com/${name}` },
  { src: `https://backup.example.com/${name}` },
]
const desktopSingle = douyinVideoVariants({
  duration: 3667, width: 720, height: 1280, dataSize: 777887,
  playAddr: desktopAddr("desktop-default"),
})
check(desktopSingle.length === 1, "桌面playAddr数组识别为一项")
check(desktopSingle[0].url === "https://example.com/desktop-default" && desktopSingle[0].alternateUrls?.[0] === "https://backup.example.com/desktop-default", "桌面src主备顺序保留")
check(desktopSingle[0].width === 720 && desktopSingle[0].height === 1280 && desktopSingle[0].byteSize === 777887 && desktopSingle[0].durationSeconds === 3.667, "桌面流尺寸大小与毫秒时长")
const desktopMulti = douyinVideoVariants({
  duration: 3667, width: 720, height: 1280,
  playAddr: desktopAddr("desktop-low"),
  playAddrH265: desktopAddr("desktop-hevc"),
  bitRateList: [
    { playAddr: desktopAddr("desktop-low"), width: 720, height: 1280, dataSize: 777887, bitRate: 1000000 },
    { playAddr: desktopAddr("desktop-high"), width: 1080, height: 1920, dataSize: 1555774, bitRate: 2000000 },
    { playAddrH265: desktopAddr("desktop-hevc"), width: 720, height: 1280, dataSize: 555555, bitRate: 700000 },
  ],
})
check(desktopMulti.length === 3, "桌面码率和编码独立，默认重复流合并")
check(desktopMulti[0].height === 1920 && desktopMulti[0].byteSize === 1555774 && desktopMulti[0].quality.includes("2000 kbps"), "桌面高码率元数据与排序")
check(desktopMulti.every(item => item.alternateUrls?.length === 1 && item.alternateUrls[0] === item.url.replace("example.com", "backup.example.com")), "桌面备用不混入其他码率或编码")
check(desktopMulti.every(item => item.durationSeconds === 3.667), "桌面所有版本继承时长")
check(desktopMulti.find(item => item.url.endsWith("desktop-low"))?.byteSize === 777887, "默认重复流不覆盖码率条目大小")
check(desktopMulti.find(item => item.url.endsWith("desktop-hevc"))?.quality.includes("H.265") === true, "桌面playAddrH265编码标签")
const desktopInvalid = douyinVideoVariants({ playAddr: [null, {}, { src: "javascript:alert(1)" }, ...desktopAddr("valid"), { src: "https://example.com/valid" }], bitRateList: [null, {}, { playAddr: [] }] })
check(desktopInvalid.length === 1 && desktopInvalid[0].alternateUrls?.length === 1, "桌面空条目非法地址及重复线路过滤")
const legacyCamel = douyinVideoVariants({ bitRate: [{ playAddr: { urlList: ["https://example.com/legacy"], width: 640, height: 360, dataSize: 42 }, bitRate: 500000 }] })
check(legacyCamel.length === 1 && legacyCamel[0].byteSize === 42 && legacyCamel[0].quality.includes("500 kbps"), "旧camelCase对象结构保持")
const desktopNoBorrow = douyinVideoVariants({ width: 1080, height: 1920, dataSize: 999999, bitRateList: [{ playAddr: desktopAddr("unknown-size") }] })
check(desktopNoBorrow[0].width === undefined && desktopNoBorrow[0].height === undefined && desktopNoBorrow[0].byteSize === undefined, "桌面码率条目不借用默认版本尺寸大小")
const desktopSameSize = douyinVideoVariants({ bitRateList: [
  { playAddr: desktopAddr("same-size-a"), width: 720, height: 1280, bitRate: 1000000 },
  { playAddr: desktopAddr("same-size-b"), width: 720, height: 1280, bitRate: 2000000 },
] })
check(desktopSameSize.length === 2 && desktopSameSize.every(item => item.alternateUrls?.length === 1), "同分辨率不同码率仍为独立版本")
Script.exit({ ok: true, checks })
