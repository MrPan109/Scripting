#!/usr/bin/env python3
"""带 SSL 适配的 URL 分片下载器（专给 googlevideo 用）。

为什么不用系统 URLSession：iOS 的信任链缺 googlevideo 的中间证书，
URLSession 会在握手阶段卡住（无回调、0 字节）；同目录的 yt_sabr2._shim_v2
提供了「AppGroup cacert → 默认 store → 不验证」的级联适配，这里复用它。

用法:
    python youtube_url_download.py <component_path|-> <url> <out_path> \
        [--size N] [--chunk-mb N] [--progress-file P] [--cancel-file C] [--referer R]

输出:
    INFO ...            过程信息
    OK <bytes>          完成
    CANCELLED           被取消（exit 130）
    ERR: ...            失败（exit 1）

支持断点续传：out_path 已有内容就从它的长度接着下（暂停/继续就是用它实现的）。
"""
import json
import os
import sys
import time

CHUNK_DEFAULT_MB = 8
MAX_RETRY = 5
READ_PIECE = 64 * 1024


class Cancelled(Exception):
    pass


def make_opener(component_path):
    """优先用 yt_sabr2 的 SSL 适配；没有就退回到「不验证证书」。"""
    if component_path and component_path != "-" and os.path.isdir(component_path):
        sys.path.insert(0, component_path)
        try:
            from yt_sabr2._shim_v2 import open_request  # type: ignore
            return open_request, "yt_sabr2_shim"
        except Exception:
            pass

    import ssl
    import urllib.request

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    class _Response:
        def __init__(self, response):
            self._response = response
            self.status = response.status
            self.headers = response.headers

        def read(self, size=None):
            return self._response.read() if size is None else self._response.read(size)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self._response.close()

    def open_request(req, timeout=60):
        return _Response(urllib.request.urlopen(req, timeout=timeout, context=ctx))

    return open_request, "unverified_ssl"


def arg_value(flag, default=None):
    if flag in sys.argv:
        index = sys.argv.index(flag)
        if index + 1 < len(sys.argv):
            return sys.argv[index + 1]
    return default


def as_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def main():
    if len(sys.argv) < 4:
        print("ERR: usage youtube_url_download.py <component|-> <url> <out> [...]")
        return 2

    component_path = sys.argv[1]
    url = sys.argv[2]
    out_path = sys.argv[3]
    expected = as_int(arg_value("--size"), 0)
    chunk_bytes = max(1, as_int(arg_value("--chunk-mb"), CHUNK_DEFAULT_MB)) * 1024 * 1024
    progress_file = arg_value("--progress-file")
    cancel_file = arg_value("--cancel-file")
    referer = arg_value("--referer")

    import urllib.error
    import urllib.request

    open_request, ssl_mode = make_opener(component_path)
    print(f"INFO ssl={ssl_mode}", flush=True)

    headers = {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1",
        "Accept": "*/*",
        "Accept-Encoding": "identity",
    }
    if referer:
        headers["Referer"] = referer

    last_report = 0.0

    def report(written, total, force=False):
        nonlocal last_report
        now = time.monotonic()
        if not progress_file or (not force and now - last_report < 0.5):
            return
        try:
            with open(progress_file + ".tmp", "w", encoding="utf-8") as handle:
                json.dump({"written": written, "total": total, "at": time.time()}, handle)
            os.replace(progress_file + ".tmp", progress_file)
            last_report = now
        except OSError:
            pass

    def cancelled():
        return bool(cancel_file) and os.path.exists(cancel_file)

    def request_range(start, end):
        req_headers = dict(headers)
        if end is not None:
            req_headers["Range"] = f"bytes={start}-{end}"
        elif start:
            req_headers["Range"] = f"bytes={start}-"
        return urllib.request.Request(url, headers=req_headers)

    # 没给总大小时先探一次：Content-Range 里带 total，其次看 Content-Length
    if expected <= 0:
        try:
            with open_request(request_range(0, 0), timeout=30) as response:
                content_range = response.headers.get("Content-Range") or ""
                if "/" in content_range:
                    expected = as_int(content_range.rsplit("/", 1)[-1], 0)
                elif response.status == 200:
                    expected = as_int(response.headers.get("Content-Length"), 0)
        except Exception as error:  # noqa: BLE001
            print(f"INFO 预探测失败（按流式继续）: {error!r}", flush=True)

    try:
        written = os.path.getsize(out_path) if os.path.exists(out_path) else 0
    except OSError:
        written = 0

    if expected and written >= expected:
        print(f"OK {written} (已完成)", flush=True)
        return 0

    print(f"INFO total={expected} resume_from={written}", flush=True)
    report(written, expected)

    next_log = written + 32 * 1024 * 1024
    try:
        with open(out_path, "ab" if written > 0 else "wb") as handle:
            while not expected or written < expected:
                if cancelled():
                    raise Cancelled()
                end = None if not expected else min(written + chunk_bytes - 1, expected - 1)
                attempt = 0
                while True:
                    try:
                        request_start = written
                        with open_request(request_range(written, end), timeout=30) as response:
                            if response.status == 200:
                                if written > 0:
                                    print("INFO 服务器忽略 Range，改为流式下载", flush=True)
                                    handle.truncate(0)
                                    handle.seek(0)
                                    written = 0
                                response_end = None
                            elif response.status == 206:
                                import re
                                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+|\*)", response.headers.get("Content-Range", ""))
                                if not match or int(match[1]) != request_start:
                                    raise ValueError("Content-Range 起点不匹配")
                                response_end = int(match[2])
                                if response_end < request_start or (end is not None and response_end > end):
                                    raise ValueError("Content-Range 终点不匹配")
                                if match[3] != "*":
                                    server_total = int(match[3])
                                    if expected and server_total != expected:
                                        raise ValueError("资源大小已变化，请重新解析")
                                    expected = server_total
                            else:
                                raise ValueError(f"意外的 HTTP 状态 {response.status}")
                            received = 0
                            while True:
                                if cancelled():
                                    raise Cancelled()
                                piece = response.read(READ_PIECE)
                                if not piece:
                                    break
                                if response_end is not None and written + len(piece) > response_end + 1:
                                    raise ValueError("响应超出请求范围")
                                handle.write(piece)
                                written += len(piece)
                                received += len(piece)
                                report(written, expected)
                            if not received:
                                raise IOError("服务器返回空数据")
                            if response_end is not None and written != response_end + 1:
                                raise IOError("分片提前结束")
                            if response.status == 200:
                                if expected and written < expected:
                                    raise IOError("流式下载提前结束")
                                expected = written
                        break
                    except Cancelled:
                        raise
                    except urllib.error.HTTPError as error:
                        attempt += 1
                        if attempt >= MAX_RETRY:
                            print(f"ERR: HTTP {error.code}", flush=True)
                            return 1
                        time.sleep(0.8 * attempt)
                    except Exception as error:  # noqa: BLE001
                        attempt += 1
                        if attempt >= MAX_RETRY:
                            print(f"ERR: {error!r}", flush=True)
                            return 1
                        time.sleep(0.8 * attempt)

                if written >= next_log:
                    next_log = written + 32 * 1024 * 1024
                    percent = f"{written * 100 // expected}%" if expected else f"{written} 字节"
                    print(f"INFO progress {percent} ({written}/{expected or '?'})", flush=True)
    except Cancelled:
        print("CANCELLED", flush=True)
        return 130

    final_size = os.path.getsize(out_path) if os.path.exists(out_path) else 0
    if expected and final_size < expected:
        print(f"ERR: 仅下到 {final_size}/{expected} 字节", flush=True)
        return 1
    report(final_size, expected or final_size, force=True)
    print(f"OK {final_size}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
