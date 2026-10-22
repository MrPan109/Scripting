import {
  Button,
  HStack,
  Image,
  List,
  Navigation,
  NavigationStack,
  ProgressView,
  Picker,
  Section,
  Slider,
  Spacer,
  Text,
  TextField,
  VStack,
  AbortController,
  useRef,
  useEffect,
  useState,
} from "scripting"
import { MediaItem, ParseResult } from "./../parser"
import { saveMedia, SaveOptions, SaveProgress } from "./../download"
import { extractURLFromText } from "./../utils/url"
import { isWorkInput, parseWork } from "./../functions/workParse"
import {
  pageURL,
  resources,
  pageTitle,
  selectedCategory,
  statusText,
  isLoading,
  toastMessage,
  toastVisible,
  initialViewMode,
  beginParseTask,
  isCurrentParseTask,
  invalidateParseTask,
} from "./../state/appState"
import { extractResources } from "./../functions/resourceExtractor"
import { hasDownloadManagerContent, getActiveDownloadCount } from "./../state/downloadManager"
import { clearLiveAudio, importLiveAudio, LiveAudioSettings, loadLiveAudioSettings, setLiveAudioEnabled, setLiveAudioRange } from "./../liveaudio"
import { ExtractSections } from "./ExtractSections"
import { DownloadManagerView } from "./DownloadManagerView"
import { SettingsView } from "./SettingsView"
import { VideoToLivePhotoView } from "./VideoToLivePhotoView"
import { formatVideoSize, videoMetadata } from "../utils/videoMetadata"
import { ActionButton, errorMessage } from "./../components/ui"
import { SaveSoundPicker, SaveSoundMode } from "../components/SaveSoundPicker"

/** 未选择任何自选声音时的初始状态 */
const NO_LIVE_AUDIO: LiveAudioSettings = { enabled: false, audioPath: null, fileName: null, durationSeconds: null, startSeconds: 0, endSeconds: null }

/** 把秒数格式化成 分:秒 */
function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`
}

function kindIcon(kind: MediaItem["kind"]): string {
  if (kind === "video") return "play.rectangle.fill"
  if (kind === "audio") return "waveform"
  if (kind === "livePhoto") return "livephoto"
  return "photo.fill"
}

export function MediaRow({ item, status, stillStatus, motionStatus, liveStatus, stillProgress, motionProgress, liveProgress, stillError, motionError, liveError, progress, busy, withAudio = false, onSave, onSaveStill, onSaveMotion, onSaveAsLive, onCancel }: {
  item: MediaItem
  status?: string
  stillStatus?: string
  motionStatus?: string
  liveStatus?: string
  stillProgress?: SaveProgress
  motionProgress?: SaveProgress
  liveProgress?: SaveProgress
  stillError?: string
  motionError?: string
  liveError?: string
  progress?: SaveProgress
  busy: boolean
  withAudio?: boolean
  onSave: () => void
  onSaveStill?: () => void
  onSaveMotion?: () => void
  onSaveAsLive?: () => void
  onCancel: () => void
}) {
  const isLivePhoto = item.kind === "livePhoto"
  const metadata = item.kind === "video" ? videoMetadata({ ...item, type: "video", name: item.fileName }) : {}
  const size = item.kind === "video" ? formatVideoSize(item.byteSize) : undefined
  const liveDuration = isLivePhoto && item.durationMs ? `实况 ${(item.durationMs / 1000).toFixed(1)} 秒` : undefined
  const durationAndSize = item.kind === "video"
    ? [metadata.duration ? `时长 ${metadata.duration}` : undefined, size ? `大小 ${size}` : undefined].filter(Boolean).join(" · ")
    : liveDuration
  const canSaveStill = Boolean(item.stillUrl && onSaveStill)
  const canSaveMotion = Boolean(isLivePhoto && onSaveMotion)
  const canSaveAsLive = Boolean(item.kind === "video" && onSaveAsLive)
  const auxiliaryExports = [
    { key: "still", label: "静图", available: canSaveStill, status: stillStatus, progress: stillProgress, error: stillError, save: onSaveStill },
    { key: "motion", label: "mp4", available: canSaveMotion, status: motionStatus, progress: motionProgress, error: motionError, save: onSaveMotion },
    { key: "live", label: "实况", available: canSaveAsLive, status: liveStatus, progress: liveProgress, error: liveError, save: onSaveAsLive },
  ].filter(entry => entry.available)
  const subtitle = item.kind === "audio" ? "导出到文件"
    : isLivePhoto ? (withAudio ? "保存为实况照片（含配乐）" : "保存为实况照片")
    : item.kind === "video" ? (withAudio ? "保存配乐视频，可另存实况" : "保存视频到照片，可另存实况")
    : "保存静态图到照片"
  const mainTitle = status === "保存中" ? "取消" : status === "失败" || status === "已取消" ? "重试" : status === "已保存" ? "已保存"
    : isLivePhoto ? "实况" : item.kind === "video" ? "视频" : "保存"
  return (
    <HStack spacing={12} alignment="center">
      {item.previewUrl ? (
        <Image
          imageUrl={item.previewUrl}
          frame={{ width: 68, height: 68 }}
          aspectRatio={{ contentMode: "fill" }}
          clipShape={{ type: "rect", cornerRadius: 6 }}
        />
      ) : (
        <Image
          systemName={kindIcon(item.kind)}
          frame={{ width: 68, height: 68 }}
          foregroundStyle="#67717E"
        />
      )}
      <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        <Text font="body" fontWeight="semibold" lineLimit={1}>{item.label}</Text>
        {item.quality ? <Text font="caption" foregroundStyle="secondaryLabel">{item.quality}</Text> : null}
        {metadata.resolution ? <Text font="caption" foregroundStyle="secondaryLabel">分辨率 {metadata.resolution}</Text> : null}
        {durationAndSize ? <Text font="caption" foregroundStyle="secondaryLabel">{durationAndSize}</Text> : null}
        <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={1}>{subtitle}</Text>
        {status === "保存中" ? (
          <VStack alignment="leading" spacing={5}>
            <Text font="caption" foregroundStyle="secondaryLabel">{progress?.text ?? "准备下载…"}</Text>
            {progress?.fraction !== undefined ? <ProgressView value={progress.fraction} total={1} /> : <ProgressView />}
          </VStack>
        ) : status ? <Text font="caption" foregroundStyle={status === "已保存" ? "green" : "secondaryLabel"}>{status}</Text> : null}
        {auxiliaryExports.map(entry => entry.status ? (
          <VStack key={entry.key} alignment="leading" spacing={5}>
            <Text font="caption" foregroundStyle={entry.status === "失败" ? "#C43A47" : entry.status === "已保存" ? "green" : "secondaryLabel"}>
              {`${entry.label}：${entry.status === "保存中" ? entry.progress?.text ?? "准备下载…" : entry.status === "失败" && entry.error ? `失败：${entry.error}` : entry.status}`}
            </Text>
            {entry.status === "保存中" ? (
              entry.progress?.fraction !== undefined ? <ProgressView value={entry.progress.fraction} total={1} /> : <ProgressView />
            ) : null}
          </VStack>
        ) : null)}
      </VStack>
      <VStack spacing={6}>
        {canSaveStill || canSaveMotion || canSaveAsLive ? (
          <HStack spacing={6}>
            {auxiliaryExports.map(entry => (
              <ActionButton
                key={entry.key}
                title={entry.status === "保存中" ? "取消" : entry.status === "失败" || entry.status === "已取消" ? "重试" : entry.status === "已保存" ? "已存" : entry.label}
                action={entry.status === "保存中" ? onCancel : entry.save as () => void}
                disabled={(busy && entry.status !== "保存中") || entry.status === "已保存" || (entry.status === "保存中" && entry.progress?.text === "正在写入相册…")}
                compact
              />
            ))}
          </HStack>
        ) : null}
        <ActionButton title={mainTitle}
          action={status === "保存中" ? onCancel : onSave}
          disabled={(busy && status !== "保存中") || status === "已保存" || progress?.text === "正在写入相册…"}
          compact={canSaveStill || canSaveMotion || canSaveAsLive} />
      </VStack>
    </HStack>
  )
}

interface ParseViewProps {
  initialInput?: string
  autoParse?: boolean
}

/**
 * 合并后的唯一入口页：一个输入框，自动分流。
 *  - 小红书 / 抖音作品 → 本机解析（无水印）→ 媒体列表（静态图 / 实况 / mp4 / mp3 / 封面）
 *  - 其它网页链接 → 网页资源提取 → 资源列表（分类、过滤、下载管理器）
 */
export function ParseView({ initialInput = "", autoParse = false }: ParseViewProps) {
  const dismiss = Navigation.useDismiss()
  const [input, setInput] = useState(initialInput)
  const [result, setResult] = useState<ParseResult | null>(null)
  const [qualitySelection, setQualitySelection] = useState<Record<string, string>>({})
  useEffect(() => { setQualitySelection({}) }, [result])
  const qualityGroups = new Map<string, MediaItem[]>()
  for (const item of result?.media ?? []) {
    if (item.qualityGroup) qualityGroups.set(item.qualityGroup, [...(qualityGroups.get(item.qualityGroup) ?? []), item])
  }
  const visibleMedia = (result?.media ?? []).filter(item => !item.qualityGroup || item.id === (qualitySelection[item.qualityGroup] ?? qualityGroups.get(item.qualityGroup)?.[0]?.id))
  const [isParsing, setIsParsing] = useState(false)
  const [message, setMessage] = useState("")
  const [audioMessage, setAudioMessage] = useState("")
  const [saveStatus, setSaveStatus] = useState<Record<string, string>>({})
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({})
  const [progress, setProgress] = useState<Record<string, SaveProgress>>({})
  const [busy, setBusy] = useState(false)

  // 实况照片的「自选声音」（小红书网页版不提供原始音轨）
  const [liveAudio, setLiveAudio] = useState<LiveAudioSettings>({ ...NO_LIVE_AUDIO })
  const [soundMode, setSoundMode] = useState<SaveSoundMode>("original")
  const [backgroundTrackId, setBackgroundTrackId] = useState("")
  const backgroundTracks = (result?.media ?? []).filter(item => item.kind === "audio")
  const backgroundTrack = backgroundTracks.find(item => item.id === backgroundTrackId) ?? backgroundTracks[0]
  const liveAudioPath = soundMode === "custom" ? liveAudio.audioPath : null
  const saveOptions = (): SaveOptions => soundMode === "background" && backgroundTrack
    ? { backgroundAudio: backgroundTrack }
    : { audioPath: liveAudioPath, audioStartSeconds: liveAudio.startSeconds, audioEndSeconds: liveAudio.endSeconds }
  const audioDuration = liveAudio.durationSeconds ?? 0
  const audioEnd = liveAudio.endSeconds ?? audioDuration
  const audioSpan = Math.max(0, audioEnd - liveAudio.startSeconds)
  const canPickAudioRange = liveAudio.audioPath !== null && audioDuration > 2.5
  const audioStartMax = Math.max(1, Math.floor(audioDuration - 1))
  const audioEndMax = Math.max(1, Math.ceil(audioDuration))
  const audioEndMin = Math.min(Math.max(1, Math.ceil(liveAudio.startSeconds) + 1), audioEndMax)
  const liveMotionSeconds = (() => {
    const durations = (result?.media ?? []).filter(item => item.kind === "livePhoto" && item.durationMs).map(item => item.durationMs as number)
    if (durations.length === 0) return null
    const average = durations.reduce((sum, value) => sum + value, 0) / durations.length / 1000
    return Math.round(average * 10) / 10
  })()

  const parseLock = useRef(false)
  const parseTask = useRef<number | null>(null)
  const mounted = useRef(true)
  const active = useRef<AbortController | null>(null)
  const locked = useRef(false)
  const cancelled = useRef(false)
  const cancel = () => { cancelled.current = true; active.current?.abort() }
  useEffect(() => () => {
    mounted.current = false
    active.current?.abort()
    if (parseTask.current !== null) invalidateParseTask(parseTask.current)
  }, [])

  const hasDownloads = hasDownloadManagerContent()
  const activeDownloadCount = getActiveDownloadCount()

  useEffect(() => {
    void (async () => {
      const settings = await loadLiveAudioSettings()
      setLiveAudio(settings)
      if (settings.enabled && settings.audioPath) setSoundMode("custom")
    })()
  }, [])

  // 从后台恢复（最小化后重新打开 / 小组件唤起）时，直接进下载管理器
  useEffect(() => {
    if (initialViewMode.value !== "downloads") return
    initialViewMode.setValue("main")
    setTimeout(() => Navigation.present(<DownloadManagerView />), 100)
  }, [])

  // 改变配乐后允许重新保存视频/实况，静图和音频的已保存状态保留。
  useEffect(() => {
    const ids = (result?.media ?? []).filter(item => item.kind === "video" || item.kind === "livePhoto").map(item => item.id)
    const retain = <T,>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).filter(([key]) => !ids.some(id => key === id || key === `${id}#motion` || key === `${id}#live`)))
    setSaveStatus(retain)
    setSaveErrors(retain)
  }, [soundMode, backgroundTrack?.id, liveAudio.audioPath, liveAudio.startSeconds, liveAudio.endSeconds])

  const changeSoundMode = (mode: SaveSoundMode) => {
    setSoundMode(mode)
    setAudioMessage("")
    void setLiveAudioEnabled(mode === "custom", liveAudio)
  }

  const chooseLiveAudio = async () => {
    setAudioMessage("")
    try {
      const picked = await importLiveAudio()
      if (picked) setLiveAudio(picked)
    } catch (error) {
      setAudioMessage(errorMessage(error))
    }
  }

  const removeLiveAudio = async () => {
    setLiveAudio({ ...NO_LIVE_AUDIO })
    setAudioMessage("")
    await clearLiveAudio()
  }

  const changeLiveAudioStart = (seconds: number) => setLiveAudio(current => ({
    ...current,
    startSeconds: seconds,
    endSeconds: current.endSeconds === null ? null : Math.max(seconds + 1, current.endSeconds),
  }))
  const changeLiveAudioEnd = (seconds: number) => setLiveAudio(current => ({
    ...current,
    endSeconds: seconds,
    startSeconds: Math.min(current.startSeconds, Math.max(0, seconds - 1)),
  }))
  const commitLiveAudioRange = () => { void setLiveAudioRange(liveAudio.startSeconds, liveAudio.endSeconds, liveAudio) }

  // ── 解析 / 提取（自动分流）────────────────────────────────────────────────
  const clearExtraction = () => {
    resources.setValue([])
    pageTitle.setValue("")
    selectedCategory.setValue("all")
    statusText.setValue("")
    isLoading.setValue(false)
  }

  const parse = async (value = input) => {
    if (!mounted.current || !value.trim() || parseLock.current || busy || locked.current) return
    parseLock.current = true
    const task = beginParseTask()
    parseTask.current = task
    const current = () => mounted.current && isCurrentParseTask(task)
    setIsParsing(true)
    setMessage("")
    setResult(null)
    setBackgroundTrackId("")
    setSaveStatus({})
    setSaveErrors({})
    clearExtraction()
    try {
      if (isWorkInput(value)) {
        // 小红书 / 抖音作品：本机解析（无水印、支持实况）
        const parsed = await parseWork(value)
        if (current()) setResult(parsed)
      } else {
        // 其它链接：网页资源提取
        const url = extractURLFromText(value)
        if (!url) {
          setMessage("没有找到可用链接，请粘贴完整的分享内容或网页地址")
          return
        }
        setInput(url)
        pageURL.setValue(url)
        await extractResources(task)
        if (current() && resources.value.length === 0 && statusText.value) setMessage(statusText.value)
      }
    } catch (error) {
      if (current()) setMessage(errorMessage(error))
    } finally {
      // 局部锁只属于这次页面调用；共享加载状态由任务持有者提交。
      if (parseTask.current === task) {
        parseLock.current = false
        if (mounted.current) setIsParsing(false)
      }
    }
  }

  const paste = async () => {
    const value = await Pasteboard.getString() ?? await Pasteboard.getURL() ?? ""
    setInput(value)
    if (!value) setMessage("剪贴板中没有文本或链接")
  }

  // ── 保存 ────────────────────────────────────────────────────────────────
  const performSave = async (item: MediaItem, key: string, options: SaveOptions = {}): Promise<string | null> => {
    const controller = new AbortController()
    active.current = controller
    setSaveErrors(current => { const next = { ...current }; delete next[key]; return next })
    setSaveStatus(current => ({ ...current, [key]: "保存中" }))
    try {
      await saveMedia(item, controller, value => setProgress(current => ({ ...current, [key]: value })), options)
      setSaveStatus(current => ({ ...current, [key]: "已保存" }))
      return null
    } catch (error) {
      const detail = errorMessage(error)
      if (detail !== "已取消") setSaveErrors(current => ({ ...current, [key]: detail }))
      setSaveStatus(current => ({ ...current, [key]: detail === "已取消" ? "已取消" : "失败" }))
      return detail
    } finally {
      active.current = null
      setProgress(current => { const next = { ...current }; delete next[key]; return next })
    }
  }

  const runExclusive = async (work: () => Promise<string | null>) => {
    if (locked.current || isParsing) return
    locked.current = true
    cancelled.current = false
    setBusy(true)
    try {
      const failure = await work()
      if (failure && failure !== "已取消") await Dialog.alert({ title: "保存失败", message: failure })
    } finally { locked.current = false; setBusy(false) }
  }

  const save = (item: MediaItem) => runExclusive(() => performSave(item, item.id, item.kind === "livePhoto" || item.kind === "video" ? saveOptions() : {}))

  // 实况照片的「静图」：同一张图的原始无水印地址
  const saveStill = (item: MediaItem) => runExclusive(() => {
    if (!item.stillUrl) return Promise.resolve(null)
    const still: MediaItem = {
      id: `${item.id}#still`,
      kind: "image",
      label: `${item.label} 静图`,
      url: item.stillUrl,
      previewUrl: item.stillUrl,
      fileName: item.fileName.replace(/\.[a-z0-9]+$/i, "") + ".jpg",
    }
    return performSave(still, still.id)
  })

  // 普通视频可选择直接合成实况照片；默认仍保存为视频，不改变原有行为。
  const saveAsLive = (item: MediaItem) => runExclusive(() => {
    const live: MediaItem = {
      ...item,
      id: `${item.id}#live`,
      kind: "livePhoto",
      fileName: item.fileName.replace(/\.[^.]+$/, "") + ".mp4",
    }
    return performSave(live, live.id, saveOptions())
  })

  // 实况照片的「mp4」：把动态片段当普通视频单独存一份
  const saveMotion = (item: MediaItem) => runExclusive(() => {
    const motion: MediaItem = {
      ...item,
      id: `${item.id}#motion`,
      kind: "video",
      label: `${item.label} 片段`,
      url: item.url,
      previewUrl: item.previewUrl,
      fileName: item.fileName.replace(/\.[a-z0-9]+$/i, "") + ".mp4",
    }
    return performSave(motion, motion.id, saveOptions())
  })

  const saveAll = async () => {
    if (!result || locked.current || isParsing) return
    locked.current = true
    cancelled.current = false
    setBusy(true)
    let saved = 0
    const failures: string[] = []
    try {
      for (const item of visibleMedia) {
        if (cancelled.current) break
        if (saveStatus[item.id] === "已保存") continue
        const failure = await performSave(item, item.id, item.kind === "livePhoto" || item.kind === "video" ? saveOptions() : {})
        if (failure) failures.push(`${item.label}：${failure}`)
        else saved += 1
      }
      await Dialog.alert({ title: cancelled.current ? "已停止保存" : "批量保存完成", message: `本次成功 ${saved} 项${failures.length ? `\n${failures.join("\n")}` : ""}` })
    } finally { locked.current = false; setBusy(false) }
  }

  useEffect(() => {
    if (initialInput) {
      if (autoParse) void parse(initialInput)
      return
    }
    void (async () => {
      const clipboard = await Pasteboard.getString() ?? await Pasteboard.getURL()
      if (!mounted.current || parseTask.current !== null) return
      if (clipboard) {
        setInput(clipboard)
        if (autoParse) void parse(clipboard)
      }
    })()
  }, [])

  const hasWork = result !== null
  const hasResources = resources.value.length > 0
  const extractionBusy = isLoading.value
  const platformName = "媒体"

  return (
    <NavigationStack>
      <List
        navigationTitle="解析提取"
        navigationBarTitleDisplayMode="inline"
        listStyle="insetGroup"
        toolbar={{
          cancellationAction: <Button title="关闭" systemImage="xmark" action={dismiss} />,
          primaryAction: (
            <HStack spacing={12}>
              {hasDownloads ? (
                <Button action={() => Navigation.present(<DownloadManagerView />)}>
                  <HStack spacing={4}>
                    <Image
                      systemName={activeDownloadCount > 0 ? "arrow.down.circle.fill" : "arrow.down.circle"}
                      foregroundStyle="#007AFF"
                      fontWeight="semibold"
                    />
                    {activeDownloadCount > 0 ? (
                      <Text font="subheadline" fontWeight="semibold">{activeDownloadCount}</Text>
                    ) : null}
                  </HStack>
                </Button>
              ) : null}
              <Button action={() => Navigation.present(<SettingsView />)}>
                <Image systemName="gearshape" fontWeight="semibold" foregroundStyle="accentColor" />
              </Button>
            </HStack>
          ),
        }}
        toast={{
          message: toastMessage.value,
          position: "top",
          isPresented: toastVisible,
          duration: 2,
        }}
      >
        <Section
          header={<Text>{hasResources ? "网页地址" : "作品链接或网页地址"}</Text>}
          footer={
            <Text>
              {hasResources
                ? "已按网页资源提取。改地址后重新点「开始解析」即可换一个页面。仅处理你有权下载和使用的内容。"
                : "粘贴分享内容或网页链接，自动识别可访问的媒体资源。可用性取决于来源页面与访问权限。仅处理你拥有权利或已获授权的内容。"}
            </Text>
          }
        >
          <TextField
            title="分享文案、作品链接或网页地址"
            value={input}
            onChanged={setInput}
            axis="vertical"
            prompt="粘贴分享内容或网页链接"
          />
          <HStack spacing={10}>
            <ActionButton title="粘贴" action={() => void paste()} disabled={busy || isParsing} />
            <Spacer />
            <ActionButton
              title={isParsing ? "处理中…" : "开始解析"}
              action={() => void parse()}
              disabled={isParsing || busy || !input.trim()}
              primary
            />
          </HStack>
          {isParsing ? <ProgressView title={extractionBusy ? (statusText.value || "正在提取网页资源") : "正在读取公开媒体信息"} /> : null}
          {message ? <Text foregroundStyle="#C43A47">{message}</Text> : null}
        </Section>

        <Section header={<Text>本地工具</Text>}>
          <Button action={() => Navigation.present(<VideoToLivePhotoView />)} disabled={busy || isParsing}>
            <HStack spacing={12}>
              <Image systemName="livephoto" foregroundStyle="accentColor" />
              <VStack alignment="leading" spacing={3}>
                <Text>视频转实况</Text>
                <Text font="caption" foregroundStyle="secondaryLabel">从相册选择视频，自选封面与时长</Text>
              </VStack>
              <Spacer />
              <Image systemName="chevron.right" font="caption" foregroundStyle="secondaryLabel" />
            </HStack>
          </Button>
        </Section>

        {hasWork ? (
          <Section
            header={<Text>{platformName}</Text>}
            footer={result?.privacyNotice ? <Text>{result.privacyNotice}</Text> : undefined}
          >
            <VStack alignment="leading" spacing={4}>
              <Text font="headline" lineLimit={2}>{result?.title}</Text>
              {result?.author ? <Text font="subheadline" foregroundStyle="secondaryLabel">{result.author}</Text> : null}
              <Text font="caption" foregroundStyle="secondaryLabel">共 {visibleMedia.length} 项媒体</Text>
            </VStack>
            <ActionButton title={busy ? "正在保存…" : "全部保存"} action={() => void saveAll()} disabled={busy} primary />
          </Section>
        ) : null}

        {hasWork && result?.media.some(item => item.kind === "livePhoto" || item.kind === "video") ? (
          <Section
            header={<Text>保存声音</Text>}
            footer={
              <Text>
                此选择用于实况、另存动态片段（mp4）、视频及视频另存实况；静图和背景音乐单独导出不受影响。配乐按动态时长播放{liveMotionSeconds ? `（本作品实况约 ${liveMotionSeconds} 秒）` : ""}。自选音频保存在本机，更换或移除时清理。
              </Text>
            }
          >
            <SaveSoundPicker mode={soundMode === "background" && !backgroundTrack ? "original" : soundMode}
              onChanged={changeSoundMode} tracks={backgroundTracks} trackId={backgroundTrack?.id ?? ""}
              onTrackChanged={setBackgroundTrackId} disabled={busy} />
            {soundMode === "custom" ? (
              <HStack spacing={10}>
                <Image systemName="music.note" foregroundStyle="#67717E" />
                <VStack alignment="leading" spacing={2} frame={{ maxWidth: "infinity" }}>
                  <Text font="subheadline" lineLimit={1}>{liveAudio.fileName ?? "尚未选择音频"}</Text>
                  <Text font="caption" foregroundStyle="secondaryLabel" lineLimit={2}>
                    {liveAudio.audioPath && liveAudio.durationSeconds
                      ? `音频共 ${formatClock(liveAudio.durationSeconds)}，取 ${formatClock(liveAudio.startSeconds)} ~ ${formatClock(audioEnd)}（${formatClock(audioSpan)}）`
                      : "从「文件」选一段音频（建议 2 秒以上，更短会循环）"}
                  </Text>
                </VStack>
                <ActionButton title={liveAudio.audioPath ? "更换" : "选择"} compact action={() => void chooseLiveAudio()} disabled={busy} />
                {liveAudio.audioPath ? <ActionButton title="移除" compact action={() => void removeLiveAudio()} disabled={busy} /> : null}
              </HStack>
            ) : null}
            {soundMode === "custom" && liveAudio.audioPath && liveAudio.durationSeconds ? (
              canPickAudioRange ? (
                <VStack alignment="leading" spacing={12}>
                  <Slider
                    disabled={busy}
                    min={0}
                    max={audioStartMax}
                    step={1}
                    value={Math.min(liveAudio.startSeconds, audioStartMax)}
                    onChanged={changeLiveAudioStart}
                    onEditingChanged={(editing: boolean) => { if (!editing) commitLiveAudioRange() }}
                    label={<Text>起点</Text>}
                    minValueLabel={<Text>0:00</Text>}
                    maxValueLabel={<Text>{formatClock(audioStartMax)}</Text>}
                  />
                  <Slider
                    disabled={busy}
                    min={audioEndMin}
                    max={audioEndMax}
                    step={1}
                    value={Math.min(Math.max(audioEnd, audioEndMin), audioEndMax)}
                    onChanged={changeLiveAudioEnd}
                    onEditingChanged={(editing: boolean) => { if (!editing) commitLiveAudioRange() }}
                    label={<Text>终点</Text>}
                    minValueLabel={<Text>{formatClock(audioEndMin)}</Text>}
                    maxValueLabel={<Text>{formatClock(audioEndMax)}</Text>}
                  />
                </VStack>
              ) : (
                <Text font="caption" foregroundStyle="secondaryLabel">音频较短，会从头循环播放，无需选区间。</Text>
              )
            ) : null}
            {soundMode === "custom" && audioMessage
              ? <Text font="caption" foregroundStyle="#C43A47">{audioMessage}</Text>
              : soundMode === "custom" && liveAudio.audioPath && liveMotionSeconds
                ? <Text font="caption" foregroundStyle="secondaryLabel">实际可听到约 {liveMotionSeconds} 秒：比这长会截断，比这短会循环。</Text>
                : null}
          </Section>
        ) : null}

        {hasWork ? (
          <Section
            header={<Text>媒体</Text>}
            footer={
              result?.media.some(item => item.kind === "livePhoto" || item.kind === "video")
                ? <Text>实况图片可保存为可长按播放的实况图，也可单独另存高清静图（静图）或动态片段（mp4）；普通视频也可选择另存为实况。</Text>
                : undefined
            }
          >
            {[...qualityGroups.entries()].filter(([, items]) => items.length > 1).map(([group, items]) => (
              <Picker key={group} title="视频画质" pickerStyle="menu" disabled={busy}
                value={qualitySelection[group] ?? items[0].id}
                onChanged={(value: string) => setQualitySelection(current => ({ ...current, [group]: value }))}>
                {items.map((item, index) => <Text key={item.id} tag={item.id}>{`${index + 1}. ${item.quality ?? "来源画质"}`}</Text>)}
              </Picker>
            ))}
            {visibleMedia.map((item: MediaItem) => (
              <MediaRow
                key={item.id}
                item={item}
                status={saveStatus[item.id]}
                stillStatus={saveStatus[`${item.id}#still`]}
                motionStatus={saveStatus[`${item.id}#motion`]}
                liveStatus={saveStatus[`${item.id}#live`]}
                stillProgress={progress[`${item.id}#still`]}
                motionProgress={progress[`${item.id}#motion`]}
                liveProgress={progress[`${item.id}#live`]}
                stillError={saveErrors[`${item.id}#still`]}
                motionError={saveErrors[`${item.id}#motion`]}
                liveError={saveErrors[`${item.id}#live`]}
                progress={progress[item.id]}
                busy={busy}
                withAudio={Boolean(liveAudioPath || (soundMode === "background" && backgroundTrack))}
                onSave={() => void save(item)}
                onSaveStill={() => void saveStill(item)}
                onSaveMotion={() => void saveMotion(item)}
                onSaveAsLive={() => void saveAsLive(item)}
                onCancel={cancel}
              />
            ))}
          </Section>
        ) : null}

        <ExtractSections hideEmptyOptions={hasWork} />

        {!hasWork && !hasResources && !isParsing && !message ? (
          <Section>
            <VStack alignment="center" spacing={10} padding={{ vertical: 18 }} frame={{ maxWidth: "infinity" }}>
              <Image systemName="link.badge.plus" font={34} foregroundStyle="#3577A8" />
              <Text font="headline">等待链接</Text>
              <Text font="footnote" foregroundStyle="secondaryLabel" multilineTextAlignment="center">
                {"支持的分享链接会在本机解析，可保存图片、视频或实况照片；\n其他网页会尝试识别图片、视频、音频等资源。"}
              </Text>
            </VStack>
          </Section>
        ) : null}
      </List>
    </NavigationStack>
  )
}
