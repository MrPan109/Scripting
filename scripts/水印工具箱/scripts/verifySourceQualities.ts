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
Script.exit({ ok: true, checks })
