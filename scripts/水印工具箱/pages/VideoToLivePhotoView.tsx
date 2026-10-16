import {
  Button, HStack, Image, List, Navigation, NavigationStack, ProgressView,
  Section, Slider, Spacer, Text, VStack, useEffect, useRef, useState,
} from "scripting"

const zh = {
  title: "视频转实况照片", choose: "选择视频", replace: "更换视频", close: "关闭",
  empty: "尚未选择视频", hint: "从相册选择一个本地视频，制作成可长按播放的实况照片。",
  instruction: "拖动滑杆选择封面和实况时长；默认保留完整视频及原有声音。",
  preview: "封面预览", source: "视频时长", settings: "实况设置", cover: "封面时刻",
  duration: "实况时长", seconds: "秒", full: "使用完整时长",
  format: "保留视频方向，生成 JPEG 封面和 MOV 配对视频。",
  generate: "生成并保存到相册", selecting: "正在读取视频…", generating: "正在生成实况照片…",
  saving: "正在保存到相册…", previewing: "正在更新封面…",
  previewFailed: "封面预览失败，请调整封面时刻重试。",
  invalid: "视频不可播放、不可读取或时长无效，请更换视频。",
  localOnly: "请选择本机视频文件。", failed: "操作失败", saved: "已保存到相册",
  savedMessage: "实况照片已经生成并保存，可以在照片 App 中长按播放。",
  cleanupFailed: "部分生成的临时文件未能清理；源视频未改动。",
  invalidPair: "生成的配对文件路径无效。",
}
const en: Record<keyof typeof zh, string> = {
  title: "Video to Live Photo", choose: "Choose Video", replace: "Change Video", close: "Close",
  empty: "No Video Selected", hint: "Choose a local video from Photos and turn it into a Live Photo.",
  instruction: "Choose the cover moment and length. The full video and original audio are kept by default.",
  preview: "Cover Preview", source: "Video Length", settings: "Live Photo Settings", cover: "Cover Moment",
  duration: "Live Photo Length", seconds: "sec", full: "Use Full Length",
  format: "Preserves orientation and creates a JPEG still plus paired MOV.",
  generate: "Create & Save to Photos", selecting: "Reading video…", generating: "Creating Live Photo…",
  saving: "Saving to Photos…", previewing: "Updating cover…",
  previewFailed: "Couldn’t preview this frame. Adjust the cover moment to try again.",
  invalid: "The video is not playable or readable, or its duration is invalid. Choose another video.",
  localOnly: "Choose a local video file.", failed: "Operation Failed", saved: "Saved to Photos",
  savedMessage: "Your Live Photo is ready. Long-press it in Photos to play.",
  cleanupFailed: "Some generated temporary files could not be removed. The source video was not changed.",
  invalidPair: "The generated pair has invalid file paths.",
}
const t = (key: keyof typeof zh) =>
  (Device.systemLanguageCode.toLowerCase().startsWith("zh") ? zh : en)[key]
const seconds = (value: number) => `${value > 0 && value < 0.1 ? value.toPrecision(2) : value.toFixed(1)} ${t("seconds")}`
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))
const coverLimit = (duration: number) => Math.max(0, duration - Math.min(0.01, duration / 2))

interface VideoSelection {
  path: string
  duration: number
  coverTime: number
  outputDuration: number
  preview: UIImage | null
}
type PairPaths = { imagePath: string; videoPath: string }

async function frameAt(asset: AVAsset, time: number, duration: number): Promise<UIImage> {
  const tolerance = MediaTime.make({ seconds: Math.min(0.1, duration), preferredTimescale: 60000 })
  const frame = await asset.generateImage(
    MediaTime.make({ seconds: time, preferredTimescale: 60000 }),
    { appliesPreferredTrackTransform: true, maximumSize: { width: 1200, height: 1200 },
      toleranceBefore: tolerance, toleranceAfter: tolerance },
  )
  return frame.image
}

async function readVideo(path: string): Promise<VideoSelection> {
  // PHPicker supplies a sandbox file path. Never pass a network URL to AVAsset.
  if (!path.startsWith("/")) throw new Error(t("localOnly"))
  const asset = new AVAsset(path)
  try {
    // Sequential loads ensure no native request is still running when finally disposes the asset.
    const duration = await asset.loadDuration()
    if (!duration.isNumeric || !Number.isFinite(duration.seconds) || duration.seconds <= 0) {
      throw new Error(t("invalid"))
    }
    if (!await asset.loadIsPlayable() || !await asset.loadIsReadable()) throw new Error(t("invalid"))
    const total = duration.seconds // Do not round short videos to zero or truncate the full-length default.
    const coverTime = Math.min(total / 2, coverLimit(total))
    const preview = await frameAt(asset, coverTime, total)
    return { path, duration: total, coverTime, outputDuration: total, preview }
  } finally {
    asset.dispose()
  }
}

// Account for the two common spellings of the same iOS sandbox path.
const pathKey = (path: string) => path.replace(/^\/private\/var\//, "/var/")
async function cleanPair(pair: PairPaths | null, sourcePath: string): Promise<boolean> {
  if (!pair) return true
  let cleaned = true
  // Only paths returned by this invocation of createFromVideo are eligible for removal.
  for (const path of new Set([pair.imagePath, pair.videoPath])) {
    if (!path.startsWith("/") || pathKey(path) === pathKey(sourcePath)) continue
    try {
      if (await FileManager.exists(path)) await FileManager.remove(path)
    } catch { cleaned = false }
  }
  return cleaned
}

export function VideoToLivePhotoView() {
  const dismiss = Navigation.useDismiss()
  const [video, setVideo] = useState<VideoSelection | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState("")
  const videoRef = useRef<VideoSelection | null>(null)
  const busyRef = useRef(false)
  const alive = useRef(true)
  const previewVersion = useRef(0)
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const invalidatePreview = () => {
    previewVersion.current += 1
    if (previewTimer.current !== null) clearTimeout(previewTimer.current)
    previewTimer.current = null
  }
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; invalidatePreview() }
  }, [])

  const commitVideo = (value: VideoSelection) => {
    videoRef.current = value
    if (alive.current) setVideo(value)
  }
  const lock = () => {
    if (!alive.current || busyRef.current) return false
    busyRef.current = true // Synchronous guard also catches two taps before the next render.
    setBusy(true)
    return true
  }
  const unlock = () => {
    busyRef.current = false
    if (alive.current) setBusy(false)
  }
  const alert = async (title: string, message: string) => {
    if (!alive.current) return
    try { await Dialog.alert({ title, message, buttonLabel: t("close") }) } catch {}
  }

  const updateCover = (value: number) => {
    const current = videoRef.current
    if (!alive.current || busyRef.current || !current || !Number.isFinite(value)) return
    invalidatePreview()
    const version = previewVersion.current
    const next = { ...current, coverTime: clamp(value, 0, coverLimit(current.duration)), preview: null }
    commitVideo(next)
    setPreviewError("")
    setPreviewing(true)
    setStatus("")
    // Debounce rapid dragging; a version token rejects older in-flight frames and errors.
    previewTimer.current = setTimeout(() => {
      previewTimer.current = null
      void (async () => {
        let asset: AVAsset | null = null
        try {
          if (!alive.current || version !== previewVersion.current) return
          asset = new AVAsset(next.path)
          const preview = await frameAt(asset, next.coverTime, next.duration)
          if (alive.current && version === previewVersion.current && videoRef.current?.path === next.path) {
            commitVideo({ ...videoRef.current, preview })
          }
        } catch {
          if (alive.current && version === previewVersion.current) setPreviewError(t("previewFailed"))
        } finally {
          asset?.dispose()
          if (alive.current && version === previewVersion.current) setPreviewing(false)
        }
      })()
    }, 120)
  }

  const chooseVideo = async () => {
    if (!lock()) return
    setStatus(t("selecting"))
    try {
      const results = await Photos.pick({ filter: PHPickerFilter.videos(), limit: 1 })
      if (!alive.current || results.length === 0) return
      const path = await results[0].videoPath()
      if (!path) throw new Error(t("invalid"))
      if (!alive.current) return
      const selected = await readVideo(path)
      if (!alive.current) return
      invalidatePreview()
      commitVideo(selected)
      setPreviewing(false)
      setPreviewError("")
    } catch (error) {
      await alert(t("failed"), error instanceof Error ? error.message : String(error))
    } finally {
      if (alive.current) setStatus("")
      unlock()
    }
  }

  const updateDuration = (value: number) => {
    const current = videoRef.current
    if (!alive.current || busyRef.current || !current || !Number.isFinite(value)) return
    commitVideo({ ...current, outputDuration: clamp(value, Math.min(0.5, current.duration / 2), current.duration) })
    setStatus("")
  }

  const createLivePhoto = async () => {
    const selected = videoRef.current
    if (!selected || !lock()) return
    let pair: PairPaths | null = null
    let saved = false
    let failure = ""
    let cleaned = true
    setStatus(t("generating"))
    try {
      if (![selected.duration, selected.outputDuration, selected.coverTime].every(Number.isFinite)
        || selected.duration <= 0 || selected.outputDuration <= 0) throw new Error(t("invalid"))
      pair = await LivePhoto.createFromVideo({
        videoPath: selected.path,
        stillTime: clamp(selected.coverTime, 0, coverLimit(selected.duration)),
        maxDuration: Math.min(selected.outputDuration, selected.duration),
        imageFormat: "jpeg",
        includeAudio: true,
      })
      if (![pair.imagePath, pair.videoPath].every(path => path.startsWith("/") && pathKey(path) !== pathKey(selected.path))
        || pathKey(pair.imagePath) === pathKey(pair.videoPath)) throw new Error(t("invalidPair"))
      if (alive.current) setStatus(t("saving"))
      await Photos.saveLivePhoto({ ...pair, shouldMoveFile: true })
      saved = true
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    } finally {
      // Success may already have moved both files. Failure still cleans the returned pair.
      // If conversion rejects before returning a pair, its native API cleans partial output.
      cleaned = await cleanPair(pair, selected.path)
    }
    try {
      const note = cleaned ? "" : t("cleanupFailed")
      if (alive.current) setStatus([saved ? t("saved") : failure, note].filter(Boolean).join("\n"))
      await alert(saved ? t("saved") : t("failed"), [saved ? t("savedMessage") : failure, note].filter(Boolean).join("\n"))
    } finally { unlock() }
  }

  const close = () => {
    if (busyRef.current) return
    alive.current = false
    invalidatePreview()
    dismiss()
  }

  return (
    <NavigationStack interactiveDismissDisabled={busy}>
      <List navigationTitle={t("title")} navigationBarTitleDisplayMode="inline" listStyle="insetGroup"
        interactiveDismissDisabled={busy}
        toolbar={{ cancellationAction: <Button title={t("close")} action={close} disabled={busy} /> }}>
        <Section footer={<Text>{t("instruction")}</Text>}>
          <Button title={video ? t("replace") : t("choose")} systemImage="video.badge.plus"
            action={() => void chooseVideo()} disabled={busy} />
        </Section>
        {!video ? (
          <Section>
            <VStack alignment="center" spacing={12} frame={{ maxWidth: "infinity" }}>
              <Image systemName="livephoto" font={{ name: "system", size: 52 }} frame={{ width: 56, height: 56 }} />
              <Text font="headline">{t("empty")}</Text>
              <Text foregroundStyle="secondaryLabel">{t("hint")}</Text>
            </VStack>
          </Section>
        ) : (
          <>
            <Section header={<Text>{t("preview")}</Text>} footer={<Text>{t("format")}</Text>}>
              <VStack spacing={10}>
                {video.preview ? <Image image={video.preview} resizable aspectRatio={{ contentMode: "fit" }}
                  frame={{ maxWidth: "infinity", height: 210 }} />
                  : previewing ? <ProgressView title={t("previewing")} /> : <Text foregroundStyle="secondaryLabel">{previewError}</Text>}
                <HStack><Text>{t("source")}</Text><Spacer /><Text>{seconds(video.duration)}</Text></HStack>
              </VStack>
            </Section>
            <Section header={<Text>{t("settings")}</Text>}>
              <VStack spacing={8}>
                <HStack><Text>{t("cover")}</Text><Spacer /><Text>{seconds(video.coverTime)}</Text></HStack>
                <Slider value={video.coverTime} min={0} max={coverLimit(video.duration)}
                  step={Math.min(0.1, coverLimit(video.duration) / 10)} onChanged={updateCover}
                  label={<Text>{t("cover")}</Text>} disabled={busy} />
              </VStack>
              <VStack spacing={8}>
                <HStack><Text>{t("duration")}</Text><Spacer /><Text>{seconds(video.outputDuration)}</Text></HStack>
                <Slider value={video.outputDuration} min={Math.min(0.5, video.duration / 2)} max={video.duration}
                  step={Math.min(0.1, video.duration / 20)} onChanged={updateDuration}
                  label={<Text>{t("duration")}</Text>} disabled={busy} />
                <Button title={t("full")} action={() => updateDuration(video.duration)} disabled={busy} />
              </VStack>
            </Section>
            <Section>
              <Button title={t("generate")} systemImage="livephoto" action={() => void createLivePhoto()} disabled={busy} />
            </Section>
          </>
        )}
        {busy || status ? <Section>{busy ? <ProgressView title={status} /> : <Text>{status}</Text>}</Section> : null}
      </List>
    </NavigationStack>
  )
}

export default VideoToLivePhotoView
