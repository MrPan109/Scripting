import { List, NavigationStack, Picker, Section, Text, VStack } from "scripting"
import type { MediaItem } from "../parser"

export type SaveSoundMode = "original" | "background" | "custom"

export function SaveSoundPicker({ mode, onChanged, tracks, trackId, onTrackChanged, disabled = false }: {
  mode: SaveSoundMode
  onChanged: (mode: SaveSoundMode) => void
  tracks: MediaItem[]
  trackId: string
  onTrackChanged: (id: string) => void
  disabled?: boolean
}) {
  return <VStack alignment="leading" spacing={8}>
    <Picker title="保存声音" pickerStyle="menu" value={mode} onChanged={(value: string) => onChanged(value as SaveSoundMode)} disabled={disabled}>
      <Text tag="original">保留原声（不合并）</Text>
      {tracks.length ? <Text tag="background">合入作品背景音乐</Text> : null}
      <Text tag="custom">使用自选音频</Text>
    </Picker>
    {mode === "background" && tracks.length > 1 ? <Picker title="背景音乐" pickerStyle="menu" value={trackId} onChanged={onTrackChanged} disabled={disabled}>
      {tracks.map(item => <Text key={item.id} tag={item.id}>{item.label}</Text>)}
    </Picker> : null}
    <Text font="caption" foregroundStyle="secondaryLabel">
      {mode === "original" ? "保留下载文件的声音；源片段没有声音时，保存后也没有声音。"
        : mode === "background" ? "保存时自动下载所选作品音乐并替换原声，长音频截断，短音频循环。"
        : "用下方选取的音频替换原声；取消选择则保留原声。"}
    </Text>
  </VStack>
}

export default function Preview() {
  return <NavigationStack><List navigationTitle="保存声音"><Section><SaveSoundPicker mode="background" onChanged={() => {}} tracks={[{ id: "audio-0", kind: "audio", label: "背景音乐", url: "https://example.invalid/audio", fileName: "audio.m4a" }]} trackId="audio-0" onTrackChanged={() => {}} /></Section></List></NavigationStack>
}
