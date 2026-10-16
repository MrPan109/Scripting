import { Button, Text } from "scripting"

/** 统一的报错文案提取。 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 应用里统一的「胶囊按钮」样式（比系统 Button 更紧凑，便于一排放多个操作）。 */
export function ActionButton({ title, action, primary = false, disabled = false, compact = false }: {
  title: string
  action: () => void
  primary?: boolean
  disabled?: boolean
  compact?: boolean
}) {
  return <Button action={action} disabled={disabled} buttonStyle="plain">
    <Text font="subheadline" fontWeight="semibold" foregroundStyle={primary ? "white" : "label"}
      padding={{ horizontal: compact ? 13 : 18, vertical: compact ? 8 : 11 }}
      background={primary ? "#286B63" : "secondarySystemFill"}
      clipShape={{ type: "rect", cornerRadius: 12 }} opacity={disabled ? 0.45 : 1}>{title}</Text>
  </Button>
}
