import {
  Button,
  Circle,
  HStack,
  Image,
  List,
  Navigation,
  NavigationStack,
  Picker,
  ProgressView,
  Section,
  Tab,
  TabView,
  Text,
  TextField,
  VStack,
  useRef,
  useEffect,
  useState,
} from "scripting"
import { ParseView } from "./pages/ParseView"
import { ActionButton, errorMessage } from "./components/ui"
import {
  applyWatermark,
  colorOption,
  DEFAULT_STYLE,
  fontSizeFor,
  imagePixelWidth,
  SIZE_PERCENTS,
  WATERMARK_COLORS,
  WatermarkFont,
  WatermarkMediaKind,
  WatermarkPosition,
  WatermarkStyle,
} from "./watermark"

interface AppProps {
  initialInput?: string
  autoParse?: boolean
}

function WatermarkView() {
  const [media, setMedia] = useState<{ path: string; kind: WatermarkMediaKind } | null>(null)
  const [source, setSource] = useState<UIImage | null>(null)
  const [imageWidth, setImageWidth] = useState<number | null>(null)
  const [text, setText] = useState("")
  const [style, setStyle] = useState<WatermarkStyle>({ ...DEFAULT_STYLE })
  const [preview, setPreview] = useState<UIImage | null>(null)
  const [previewPath, setPreviewPath] = useState<string | null>(null)
  const [previewKey, setPreviewKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")
  const previewRef = useRef<string | null>(null)

  // 参数变了就让旧预览失效，避免“看着是旧的、存的是新的”
  const settingsKey = [media?.path ?? "", text.trim(), style.position, style.font, String(style.sizePercent), style.color].join("|")
  const previewStale = previewPath !== null && previewKey !== settingsKey
  const color = colorOption(style.color)
  const fontPx = imageWidth !== null ? fontSizeFor(imageWidth, style.sizePercent) : null
  const canPreview = media !== null && media.kind === "image" && text.trim().length > 0

  const clearPreview = async () => {
    const path = previewRef.current
    previewRef.current = null
    setPreviewPath(null)
    setPreview(null)
    setPreviewKey("")
    if (path) { try { if (await FileManager.exists(path)) await FileManager.remove(path) } catch {} }
  }

  useEffect(() => () => {
    const path = previewRef.current
    if (path) { try { FileManager.removeSync(path) } catch {} }
  }, [])

  const thumbnail = (image: UIImage, maxSide: number): UIImage => {
    if (image.width <= maxSide) return image
    return image.preparingThumbnail({ width: maxSide, height: Math.max(1, Math.round((image.height / image.width) * maxSide)) }) ?? image
  }

  const pick = async () => {
    if (busy) return
    setMessage("")
    try {
      const results = await Photos.pick({ limit: 1 })
      if (!results || results.length === 0) return
      const item = results[0]
      let imagePath: string | null | undefined
      let videoPath: string | null | undefined
      try { imagePath = await item.imagePath() } catch {}
      try { videoPath = await item.videoPath() } catch {}
      if (imagePath) {
        await clearPreview()
        setMedia({ path: imagePath, kind: "image" })
        const full = UIImage.fromFile(imagePath)
        setSource(full ? thumbnail(full, 300) : null)
        setImageWidth(null)
        void imagePixelWidth(imagePath).then(width => setImageWidth(width)).catch(() => {})
      } else if (videoPath) {
        await clearPreview()
        setMedia({ path: videoPath, kind: "video" })
        setSource(null)
        setImageWidth(null)
        setMessage("视频加水印暂不可用：本机 ffmpeg 对视频重新编码会卡死，请改选照片。")
      } else {
        setMessage("无法读取所选内容")
      }
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  const makePreview = async () => {
    if (!media || busy) return
    if (media.kind === "video") { setMessage("视频加水印暂不可用，请改选照片。"); return }
    if (!text.trim()) { setMessage("请先输入水印内容"); return }
    setBusy(true)
    setMessage("")
    try {
      await clearPreview()
      const outputPath = `${FileManager.temporaryDirectory}/wm-preview-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`
      await applyWatermark(media.path, outputPath, "image", text, style)
      const full = UIImage.fromFile(outputPath)
      if (!full) throw new Error("预览图生成失败")
      if (imageWidth === null) setImageWidth(full.width)
      previewRef.current = outputPath
      setPreviewPath(outputPath)
      setPreview(thumbnail(full, 1400))
      setPreviewKey(settingsKey)
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!previewPath || busy) return
    setBusy(true)
    setMessage("")
    try {
      const ok = await Photos.savePhoto(previewPath, { fileName: `watermarked-${Date.now()}` })
      setMessage(ok ? "已保存到相册" : "已生成但系统未能保存，请检查相册权限")
    } catch (error) {
      setMessage(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  // 点开用系统看图器（QuickLook）全屏看：自适应屏幕、可双指缩放，看到的是原尺寸成品图
  const openFullPreview = async () => {
    if (!previewPath || busy) return
    try {
      const full = UIImage.fromFile(previewPath)
      if (!full) { setMessage("预览图读取失败，请重新生成预览"); return }
      await QuickLook.previewImage(full, true)
    } catch (error) {
      setMessage(errorMessage(error))
    }
  }

  return (
    <NavigationStack>
      <List navigationTitle="加水印" navigationBarTitleDisplayMode="inline" listStyle="insetGroup">
        <Section header={<Text>选择媒体</Text>}>
          {media ? (
            <HStack spacing={12} alignment="center">
              {source ? (
                <Image image={source} frame={{ width: 64, height: 64 }} aspectRatio={{ contentMode: "fill" }} clipShape={{ type: "rect", cornerRadius: 6 }} />
              ) : (
                <Image systemName={media.kind === "video" ? "video.fill" : "photo.fill"} frame={{ width: 64, height: 64 }} foregroundStyle="#67717E" />
              )}
              <VStack alignment="leading" spacing={3}>
                <Text font="body" fontWeight="semibold">{media.kind === "video" ? "视频" : imageWidth ? `照片 · 宽 ${imageWidth} px` : "照片"}</Text>
                <Text font="caption" foregroundStyle="secondaryLabel">{media.kind === "video" ? "视频暂不支持，请改选照片" : "可点击下方按钮重新选择"}</Text>
              </VStack>
            </HStack>
          ) : (
            <Text font="footnote" foregroundStyle="secondaryLabel">尚未选择照片或视频</Text>
          )}
          <ActionButton title="选择照片" action={() => void pick()} disabled={busy} />
        </Section>

        <Section header={<Text>水印内容</Text>} footer={<Text>支持中文、生僻字与 emoji；文字太长会自动换行。</Text>}>
          <TextField title="水印文字" value={text} onChanged={setText} axis="vertical" prompt="输入要添加的水印文字" />
        </Section>

        <Section header={<Text>水印位置</Text>}>
          <Picker title="位置" value={style.position} onChanged={(value: string) => setStyle(current => ({ ...current, position: value as WatermarkPosition }))} pickerStyle="segmented">
            <Text tag="bottomRight">右下</Text>
            <Text tag="bottomLeft">左下</Text>
            <Text tag="topRight">右上</Text>
            <Text tag="topLeft">左上</Text>
            <Text tag="center">居中</Text>
          </Picker>
        </Section>

        <Section header={<Text>字体</Text>}>
          <Picker title="字体" value={style.font} onChanged={(value: string) => setStyle(current => ({ ...current, font: value as WatermarkFont }))} pickerStyle="segmented">
            <Text tag="heiti">黑体</Text>
            <Text tag="yuanti">圆体</Text>
            <Text tag="mingchao">明朝</Text>
          </Picker>
        </Section>

        <Section
          header={<Text>字号</Text>}
          footer={<Text>{imageWidth ? `按图片宽度的百分比计算：当前照片宽 ${imageWidth} px，${style.sizePercent}% 即约 ${fontPx} px 高的字。` : "按图片宽度的百分比计算，所以不同尺寸的照片看起来一样大。"}</Text>}
        >
          <Picker title="字号" pickerStyle="menu" value={String(style.sizePercent)} onChanged={(value: string) => setStyle(current => ({ ...current, sizePercent: Number(value) }))}>
            {SIZE_PERCENTS.map(percent => (
              <Text key={String(percent)} tag={String(percent)}>{imageWidth ? `${percent}% ≈ ${fontSizeFor(imageWidth, percent)} px` : `${percent}%`}</Text>
            ))}
          </Picker>
        </Section>

        <Section header={<Text>字体颜色</Text>} footer={<Text>当前 {color.name}色；描边自动配成对比色，任何底图上都看得清。</Text>}>
          <VStack spacing={14}>
            {[0, 1].map(row => (
              <HStack key={String(row)} spacing={26}>
                {WATERMARK_COLORS.slice(row * 4, row * 4 + 4).map(option => (
                  <Button key={option.id} buttonStyle="plain" action={() => setStyle(current => ({ ...current, color: option.id }))}>
                    <VStack spacing={6}>
                      <Circle
                        fill={option.fill}
                        stroke={{ shapeStyle: { light: "#D1D1D6", dark: "#48484A" }, strokeStyle: { lineWidth: 1 } }}
                        frame={{ width: 30, height: 30 }}
                        overlay={style.color === option.id
                          ? <Circle stroke={{ shapeStyle: { light: "#3C3C43", dark: "#EBEBF5" }, strokeStyle: { lineWidth: 2 } }} frame={{ width: 38, height: 38 }} />
                          : undefined}
                      />
                      <Text font="caption2" foregroundStyle={style.color === option.id ? "label" : "secondaryLabel"}>{option.name}</Text>
                    </VStack>
                  </Button>
                ))}
              </HStack>
            ))}
          </VStack>
        </Section>

        <Section footer={<Text>先点「生成预览」看效果，满意后再保存；改动了上面的参数需要重新预览。</Text>}>
          {busy ? <ProgressView title="正在处理…" /> : null}
          <ActionButton title={previewPath ? "重新生成预览" : "生成预览"} action={() => void makePreview()} disabled={busy || !canPreview} primary />
          <ActionButton title={previewStale ? "全屏查看（旧参数）" : "全屏查看"} action={() => void openFullPreview()} disabled={busy || !previewPath} />
          <ActionButton title="保存原尺寸到相册" action={() => void save()} disabled={busy || !previewPath || previewStale} />
        </Section>

        {previewPath ? (
          <Section
            header={<Text>预览</Text>}
            footer={<Text>{previewStale ? "参数已修改，请重新生成预览。" : "这里只是缩小显示，点一下图（或「全屏查看」）可用系统看图器全屏、双指缩放看细节；保存到相册的是原尺寸成品图。"}</Text>}
          >
            {preview ? (
              <Image
                image={preview}
                resizable
                scaleToFit
                frame={{ maxWidth: "infinity", height: 260 }}
                clipShape={{ type: "rect", cornerRadius: 10 }}
                opacity={previewStale ? 0.45 : 1}
                onTapGesture={() => void openFullPreview()}
              />
            ) : null}
          </Section>
        ) : null}

        {message ? <Section><Text foregroundStyle={message.startsWith("已保存") ? "green" : "#C43A47"}>{message}</Text></Section> : null}
      </List>
    </NavigationStack>
  )
}

export default function WatermarkApp(props: AppProps) {
  return (
    <TabView>
      <Tab title="解析提取" systemImage="arrow.down.doc">
        <ParseView initialInput={props.initialInput} autoParse={props.autoParse} />
      </Tab>
      <Tab title="加水印" systemImage="seal">
        <WatermarkView />
      </Tab>
    </TabView>
  )
}
