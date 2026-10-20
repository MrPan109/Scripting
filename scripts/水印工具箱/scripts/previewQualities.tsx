import { List, NavigationStack, Picker, Section, Text, useState } from "scripting"
import { MediaRow } from "../pages/ParseView"
export default function Preview() {
  const [value, setValue] = useState("high")
  return <NavigationStack><List navigationTitle="画质选择" listStyle="insetGroup">
    <Section title="多画质视频">
      <Picker title="视频画质" pickerStyle="menu" value={value} onChanged={setValue}>
        <Text tag="high">1. 1920 × 1080 · 2000 kbps · H.264</Text>
        <Text tag="low">2. 1280 × 720 · 1000 kbps · H.264</Text>
      </Picker>
      <MediaRow item={{ id: value, kind: "video", label: "视频", url: "https://example.com/video", fileName: "video.mp4", quality: value === "high" ? "1920 × 1080 · 2000 kbps · H.264" : "1280 × 720 · 1000 kbps · H.264", byteSize: 4500000, durationSeconds: 20 }} busy={false} onSave={() => {}} onCancel={() => {}} />
    </Section>
    <Section title="单画质视频"><MediaRow item={{ id: "one", kind: "video", label: "视频", url: "https://example.com/one", fileName: "one.mp4", quality: "来源画质（分辨率未知）" }} busy={false} onSave={() => {}} onCancel={() => {}} /></Section>
  </List></NavigationStack>
}
