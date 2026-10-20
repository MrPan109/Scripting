import { HStack, Image, LabeledContent, List, Script, Section, Text, VStack } from "scripting"

// 新版本发布时，在此按时间倒序补充更新说明。
const releases = [
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
