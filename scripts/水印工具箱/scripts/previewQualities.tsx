import { List, NavigationStack, Section, Text } from "scripting"
import { MediaRow } from "../pages/ParseView"
export default function Preview() {
  return <NavigationStack><List navigationTitle="保存类型" listStyle="insetGroup">
    <Section title="实况图片">
      <MediaRow item={{ id: "live", kind: "livePhoto", label: "实况照片 1", url: "https://example.com/live.mp4", stillUrl: "https://example.com/still.jpg", previewUrl: "https://example.com/still.jpg", fileName: "live.mp4", durationMs: 3200 }} busy={false} onSave={() => {}} onSaveStill={() => {}} onSaveMotion={() => {}} onCancel={() => {}} />
    </Section>
    <Section title="普通视频">
      <MediaRow item={{ id: "video", kind: "video", label: "视频", url: "https://example.com/video.mp4", previewUrl: "https://example.com/cover.jpg", fileName: "video.mp4", quality: "1920 × 1080 · H.264", byteSize: 4500000, durationSeconds: 20 }} busy={false} onSave={() => {}} onSaveAsLive={() => {}} onCancel={() => {}} />
    </Section>
    <Section title="普通图片">
      <MediaRow item={{ id: "image", kind: "image", label: "图片 1", url: "https://example.com/image.jpg", previewUrl: "https://example.com/image.jpg", fileName: "image.jpg" }} busy={false} onSave={() => {}} onCancel={() => {}} />
    </Section>
    <Section footer={<Text>实况图片可选择保存实况、静图或动态片段；普通视频可选择保存视频或实况。</Text>}>
      <Text font="caption" foregroundStyle="secondaryLabel">同一资源会按来源实际提供的类型显示选项。</Text>
    </Section>
  </List></NavigationStack>
}
