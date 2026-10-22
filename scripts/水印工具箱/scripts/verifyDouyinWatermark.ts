import { Script } from "scripting"
import { watermarkFreeCandidate } from "../functions/watermarkFree"

let checks = 0
function check(value: boolean, label: string) { if (!value) throw new Error(`FAIL: ${label}`); checks++ }
const cases: [string, string | null][] = [
  ["https://aweme.snssdk.com/aweme/v1/playwm/?video_id=abc123&ratio=720p&line=0", "https://aweme.snssdk.com/aweme/v1/play/?video_id=abc123&ratio=1080p"],
  ["https://m.douyin.com/aweme/v1/playwm/?video_id=abc123&ratio=720p", "https://aweme.snssdk.com/aweme/v1/play/?video_id=abc123&ratio=1080p"],
  ["https://aweme.snssdk.com/aweme/v1/play/?video_id=abc123&ratio=720p", null],
  ["https://cdn.example.com/video.mp4", null],
  ["https://aweme.snssdk.com/aweme/v1/playwm/?video_id=bad%20id", null],
]
for (const [source, expected] of cases) {
  const actual = watermarkFreeCandidate(source)
  if (actual !== expected) console.log(JSON.stringify({ source: new URL(source).pathname, expected, actual }))
  check(actual === expected, `candidate conversion for ${new URL(source).pathname}`)
}
const primary = watermarkFreeCandidate(cases[0][0])!
const alternate = watermarkFreeCandidate("https://m.douyin.com/aweme/v1/playwm/?video_id=abc123&ratio=540p")!
check(primary.includes("video_id=abc123") && alternate.includes("video_id=abc123"), "preserve media ID for primary and alternate")
check(!/playwm/.test(primary) && !/playwm/.test(alternate), "never emit playwm URL as converted source")
console.log(`PASS: ${checks} watermark-source checks`)
Script.exit({ ok: true, checks })
