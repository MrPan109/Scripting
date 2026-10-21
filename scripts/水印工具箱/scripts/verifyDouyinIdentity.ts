import { Script } from "scripting"
import { douyinOwnedData, douyinWorkId } from "../utils/douyinIdentity"
import { resourcesFromDouyinData } from "../services/parsers/douyin"

// 全部为合成 ID 和地址；仅调用纯转换接口，不加载页面或下载媒体。
let checks = 0
const failures: string[] = []
function check(value: boolean, message: string) {
  checks++
  if (!value) failures.push(message)
}
function equal(actual: unknown, expected: unknown, message: string) {
  check(JSON.stringify(actual) === JSON.stringify(expected), message)
}
const ids = [15, 16, 17, 18, 19, 20].map(length => "7" + "3".repeat(length - 1))
const target = ids[4]
const other = ids[5]
const video = (name: string) => ({ duration: 3200, width: 1080, height: 1920,
  play_addr: { url_list: [`https://media.example.invalid/${name}.mp4`] } })
const work = (id: string, name: string) => ({ aweme_id: id, desc: name, video: video(name) })
const wanted = work(target, "target")
const recommendation = work(other, "recommendation")
const parse = (root: unknown, id = target) => resourcesFromDouyinData(root, { url: `https://www.douyin.com/note/${id}`, html: "" })
const baseline = parse(wanted)
check(baseline.length === 1 && baseline[0].url === "https://media.example.invalid/target.mp4", "基线提取目标视频")
check(baseline[0]?.name === "target_1.mp4", "标题属于目标作品")

for (const id of ids) {
  for (const path of ["video", "note", "gallery", "slides", "share/video"]) {
    equal(douyinWorkId(`https://www.douyin.com/${path}/${id}?test=1`), id, `${id.length}位 ${path} ID完整保留`)
  }
  for (const key of ["modal_id", "aweme_id", "item_id"]) {
    equal(douyinWorkId(`https://www.douyin.com/?${key}=${id}&test=1`), id, `${id.length}位 ${key}查询参数`)
  }
  for (const key of ["aweme_id", "awemeId", "item_id", "itemId"]) {
    const root = { [key]: id, desc: "target", video: video("target") }
    check(douyinOwnedData(root, id).length === 1, `${id.length}位 ${key}字符串匹配`)
    check(parse(root, id).length === 1, `${id.length}位 ${key}资源输出`)
  }
}
for (const invalid of ["12345678901234", "123456789012345678901", `${target}x`]) {
  equal(douyinWorkId(`https://www.douyin.com/video/${invalid}`), undefined, "拒绝非15–20位完整路径ID")
  equal(douyinWorkId(`https://www.douyin.com/?item_id=${invalid}`), undefined, "拒绝非15–20位完整查询ID")
}

equal(parse({ recommendations: [recommendation], detail: wanted }), baseline, "混合推荐只提取目标")
equal(parse({ ...wanted, recommendations: [recommendation], author: { images: [{ url_list: ["https://media.example.invalid/avatar.jpg"] }] } }), baseline, "目标内嵌其他作品及作者不污染媒体")
equal(douyinOwnedData({ ...wanted, recommendations: [recommendation] }, target), [{ desc: "target", video: wanted.video }], "所有权投影仅保留目标自身字段")
equal(parse({ recommendations: [recommendation] }), [], "目标缺失不返回推荐")
equal(parse({ desc: "unknown", video: video("unknown") }), [], "无ID根媒体不被接收")
equal(parse({ video: video("unknown"), payload: { detail: wanted } }), baseline, "无ID根允许查找明确ID子对象")
equal(parse({ ...recommendation, nested: wanted }), [], "其他作品边界不深入")
equal(douyinOwnedData({ itemId: target, title: "route" }, target), [], "纯路由匹配不产生空投影")

for (const key of ["aweme_id", "awemeId", "item_id", "itemId"]) {
  const route = { [key]: target, title: "route-title", loader: "detail", children: {
    unknown: { video: video("unknown") }, recommended: recommendation, detail: wanted,
  } }
  equal(parse(route), baseline, `${key}路由继续深入真正作品且不继承路由标题`)
  equal(douyinOwnedData(route, target), [{ desc: "target", video: wanted.video }], `${key}路由仅返回明确归属媒体`)
  equal(parse({ [key]: target, child: { video: video("unknown") } }), [], `${key}路由不把身份传给无ID媒体`)
  equal(parse({ [key]: target, child: recommendation }), [], `${key}路由不接收其他ID媒体`)
}
equal(parse({ itemId: target, video: "route-component", images: null, child: wanted }), baseline, "非媒体类型字段不遮挡子作品")
equal(parse({ itemId: target, child: { itemId: target, child: wanted } }), baseline, "多层匹配路由容器")

for (const id of ids) {
  equal(parse({ aweme_id: Number(id), video: video("numeric") }, id), [], `${id.length}位数值ID不猜测归属`)
  equal(douyinOwnedData({ itemId: Number(id), child: work(id, "hidden") }, id), [], "数值ID边界不深入")
}
const adjacent = target.slice(0, -1) + (Number(target.slice(-1)) + 1).toString()
check(Number(target) === Number(adjacent), "精度碰撞样本确实折叠为相同Number")
equal(parse(work(adjacent, "adjacent")), [], "相邻字符串ID仍严格隔离")
equal(parse(JSON.parse(`{"aweme_id":${target},"video":${JSON.stringify(video("rounded"))}}`)), [], "JSON数值ID精度丢失后拒绝")
equal(parse([ { aweme_id: Number(target), video: video("rounded") }, wanted ]), baseline, "数值ID推荐不遮挡独立字符串目标")

const still = (name: string) => ({ url_list: [`https://media.example.invalid/${name}~tplv-dy:640:800.jpeg`, `https://media.example.invalid/${name}~tplv-dy:1080:1350.jpeg`] })
const live = { ...still("shared"), video: video("target-motion") }
const gallery = { aweme_id: target, desc: "gallery", images: [live, { ...still("shared"), video: video("target-motion") }, still("plain")], image_post_info: { images: [live] } }
const foreignGallery = { aweme_id: other, desc: "foreign", images: [{ ...still("shared"), video: video("foreign-motion") }] }
const galleryBaseline = parse(gallery)
check(galleryBaseline.length === 2, "同图重复结构合并且普通静图保留")
check(galleryBaseline.every(item => item.type === "image"), "实况动态不另列视频")
const paired = galleryBaseline.find(item => item.url.includes("/shared~"))
check(paired?.url.includes("1080:1350") === true, "同图选择最大静帧")
check(paired?.livePhotoUrl === "https://media.example.invalid/target-motion.mp4", "同图实况配对目标动态")
check(paired?.livePhotoDurationSeconds === 3.2, "实况时长保留")
check(!galleryBaseline.find(item => item.url.includes("/plain~"))?.livePhotoUrl, "普通静图不借用相邻动态")
for (const field of ["image_post_info", "imagePostInfo"]) {
  equal(parse({ aweme_id: target, desc: "gallery", [field]: { images: gallery.images } }), galleryBaseline, `${field}媒体识别`)
}
// 比较完整资源数组，包括名称、顺序、备用线路和元数据。
for (const roots of [
  [foreignGallery, gallery, recommendation],
  [recommendation, gallery, foreignGallery],
  [gallery, foreignGallery, recommendation],
  [recommendation, foreignGallery, gallery],
]) equal(parse(roots), galleryBaseline, "推荐顺序变化不改变同图实况完整结果")
for (const roots of [[recommendation, wanted], [wanted, recommendation]]) {
  equal(parse(roots), baseline, "推荐顺序变化不改变视频完整结果")
}
const cyclic: Record<string, unknown> = { itemId: target, child: wanted }
cyclic.self = cyclic
equal(parse(cyclic), baseline, "循环路由容器有界且不重复")

console.log(JSON.stringify({ ok: failures.length === 0, checks, failures }))
if (failures.length) throw new Error(`Douyin identity: ${failures.length}/${checks} failed: ${failures.join("; ")}`)
Script.exit({ ok: true, checks })
