import { HStack, Image, LabeledContent, List, Script, Section, Text, VStack } from "scripting"

// 新版本发布时，在此按时间倒序补充更新说明。
const releases = [
  {
    version: "1.2.5",
    title: "视频来源优化",
    changes: [
      "修正部分视频解析误选带水印播放源的问题，优先采用可核对的官方无水印来源。",
      "加强作品归属校验和解析任务隔离，避免混入无关媒体或旧结果覆盖新结果。",
      "完善来源地址验证及备用线路处理。",
    ],
  },
  {
    version: "1.2.4",
    title: "解析归属与结果稳定性",
    changes: [
      "加强作品归属校验，避免混入推荐内容、头像及其他无关媒体；无法确认归属时提示获取失败。",
      "修复旧解析或过滤任务覆盖新结果的问题，保持资源、进度和错误提示一致。",
      "完善动态片段的备用线路选择与页面读取超时处理。",
      "已知限制：部分动态作品仍无法取得动态片段，本次未解决这些来源的实况获取。",
    ],
  },
  {
    version: "1.2.3",
    title: "图文实况与保存类型",
    changes: [
      "来源返回受支持的动态数据时，可识别图文实况并保留静图与动态片段；识别能力不代表所有动态来源均可获取。",
      "实况图片可选择保存实况照片、静态图或动态片段；普通视频也可另存为实况照片。",
      "沿用默认保存方式，并为实况提供独立的保存类型选择。",
    ],
  },
  {
    version: "1.2.2",
    title: "来源画质选择",
    changes: [
      "解析来源提供多种视频画质时，按真实分辨率、帧率、码率或编码列出可选版本。",
      "同一画质的备用地址合并保存；选择和全部保存都会使用当前选中的版本。",
      "补强各类来源的版本保留，并避免把不同视频混为同一画质组。",
    ],
  },
  {
    version: "1.2.1",
    title: "关于与更新说明",
    changes: [
      "设置中新增「关于」入口，可查看当前版本和工具箱简介。",
      "新增版本更新说明，按版本从新到旧展示。",
    ],
  },
  {
    version: "1.2.0",
    title: "视频转实况",
    changes: [
      "新增独立的「视频转实况」工具，可从相册选择本地视频并保存为实况照片。",
      "支持预览、调整封面时刻和实况时长，默认保留完整视频时长与原有声音。",
    ],
  },
  {
    version: "1.1.0",
    title: "基础功能",
    changes: [
      "此版本已包含链接解析、媒体下载、实况照片配音和照片文字水印功能。",
      "早期逐项更新记录未保留，此处为已确认的功能概览。",
    ],
  },
]

export default function AboutView() {
  return (
    <List navigationTitle="关于" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
      <Section>
        <HStack spacing={12}>
          <Image systemName={"seal.fill"} font={32} foregroundStyle="#087E8B" frame={{ width: 44, height: 44 }} />
          <VStack alignment="leading" spacing={4}>
            <Text font="headline">水印工具箱</Text>
            <Text font="subheadline" foregroundStyle="secondaryLabel">媒体解析、照片水印与实况制作</Text>
          </VStack>
        </HStack>
        <LabeledContent title="当前版本" value={Script.metadata.version} />
      </Section>
      <Section title="简介">
        <Text font="subheadline" foregroundStyle="secondaryLabel">
          从分享链接或网页识别图片、视频和音频，保存媒体，为照片添加文字水印，也可将本地视频制作成实况照片。
        </Text>
      </Section>
      {releases.map(release => (
        <Section key={release.version} title={`${release.version} · ${release.title}`}>
          {release.changes.map(change => (
            <Text key={change} font="subheadline">{change}</Text>
          ))}
        </Section>
      ))}
    </List>
  )
}
