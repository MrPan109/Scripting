import { HStack, Image, Link, Script, Spacer, Text, VStack, Widget } from "scripting"

const runURL = Script.createRunSingleURLScheme("水印工具箱", { auto: "1" })
const background = { light: "#F4F7F8", dark: "#171B1D" } as const
const primary = { light: "#172126", dark: "#F3F6F7" } as const
const secondary = { light: "#59666C", dark: "#AEB9BE" } as const
const accent = { light: "#087E8B", dark: "#55C6CF" } as const

function Shell({ children }: { children: any }) {
  return (
    <Link url={runURL}>
      <VStack frame={Widget.displaySize} background={background} widgetBackground={background}>
        {children}
      </VStack>
    </Link>
  )
}

function SmallWidget() {
  return (
    <Shell>
      <VStack alignment="leading" spacing={8} padding frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <Image systemName="seal.fill" font={28} foregroundStyle={accent} />
        <Spacer />
        <Text font={17} fontWeight="bold" foregroundStyle={primary} lineLimit={2}>去水印 · 加水印</Text>
        <Text font="caption2" foregroundStyle={secondary} lineLimit={2}>解析 · 提取 · 加水印</Text>
      </VStack>
    </Shell>
  )
}

function WideWidget() {
  return (
    <Shell>
      <HStack spacing={16} padding={{ horizontal: 18, vertical: 14 }} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <VStack alignment="leading" spacing={6}>
          <Text font={18} fontWeight="bold" foregroundStyle={primary}>水印工具箱</Text>
          <Text font="footnote" foregroundStyle={secondary}>链接解析 · 资源保存</Text>
          <Spacer />
          <HStack spacing={5}>
            <Image systemName="doc.on.clipboard" font={12} foregroundStyle={accent} />
            <Text font="caption" fontWeight="semibold" foregroundStyle={accent}>读取剪贴板并解析/提取</Text>
          </HStack>
        </VStack>
        <Spacer />
        <VStack spacing={8}>
          <Image systemName="photo.on.rectangle.angled" font={26} foregroundStyle="#D85758" />
          <Image systemName="play.rectangle.fill" font={26} foregroundStyle="#3178A6" />
        </VStack>
      </HStack>
    </Shell>
  )
}

function LargeWidget() {
  return (
    <Shell>
      <VStack alignment="leading" spacing={14} padding frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
        <HStack>
          <VStack alignment="leading" spacing={4}>
            <Text font="title2" fontWeight="bold" foregroundStyle={primary}>水印工具箱</Text>
            <Text font="subheadline" foregroundStyle={secondary}>保存公开作品中的原始媒体</Text>
          </VStack>
          <Spacer />
          <Image systemName="seal.fill" font={30} foregroundStyle={accent} />
        </HStack>
        <VStack alignment="leading" spacing={12}>
          <HStack spacing={12}>
            <Image systemName="link" font={19} foregroundStyle="#68747A" frame={{ width: 30 }} />
            <VStack alignment="leading" spacing={2}>
              <Text font="body" fontWeight="semibold" foregroundStyle={primary}>粘贴分享文案或网页链接</Text>
              <Text font="caption" foregroundStyle={secondary}>分享链接 / 网页资源</Text>
            </VStack>
          </HStack>
          <HStack spacing={12}>
            <Image systemName="square.and.arrow.down" font={19} foregroundStyle="#D85758" frame={{ width: 30 }} />
            <VStack alignment="leading" spacing={2}>
              <Text font="body" fontWeight="semibold" foregroundStyle={primary}>逐项或批量保存</Text>
              <Text font="caption" foregroundStyle={secondary}>图片、视频保存到照片</Text>
            </VStack>
          </HStack>
        </VStack>
        <Spacer />
        <HStack>
          <Text font="caption" fontWeight="semibold" foregroundStyle={accent}>点击开始解析</Text>
          <Spacer />
          <Image systemName="chevron.right" font="caption" foregroundStyle={accent} />
        </HStack>
      </VStack>
    </Shell>
  )
}

const view = Widget.family === "systemSmall" ? <SmallWidget /> : Widget.family === "systemMedium" ? <WideWidget /> : <LargeWidget />
Widget.present(view)
