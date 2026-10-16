"""离线回归：响应分块、续传、半途断流、忽略 Range、空响应和取消。"""
import contextlib
import importlib.util
import io
import os
import re
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('downloader', os.path.join(os.path.dirname(__file__), 'youtube_url_download.py'))
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)
DATA = bytes(range(251)) * 11000

class DownloadTests(unittest.TestCase):
    def run_case(self, mode='range', resume=0, known=True):
        with tempfile.TemporaryDirectory() as folder:
            out = os.path.join(folder, 'media')
            progress = out + '.json'
            cancel = out + '.cancel'
            if resume:
                with open(out, 'wb') as f:
                    f.write(DATA[:resume])
            calls = []
            reads = []
            failed = [False]
            class Response:
                def __init__(self, start, end):
                    self.status = 200 if mode in ('ignore', 'unknown') else 206
                    self.start = 0 if self.status == 200 else start
                    self.end = len(DATA)-1 if self.status == 200 else end
                    self.pos = self.start
                    self.headers = {'Content-Range': f'bytes {self.start}-{self.end}/{len(DATA)}', 'Content-Length': str(self.end-self.start+1)}
                    if mode == 'bad-range':
                        self.headers['Content-Range'] = f'bytes 9-{self.end}/{len(DATA)}'
                def __enter__(self): return self
                def __exit__(self, *args): pass
                def read(self, n=None):
                    assert n is not None, 'unbounded read'
                    reads.append(n)
                    if mode == 'empty': return b''
                    if mode == 'drop' and self.pos > self.start and not failed[0]:
                        failed[0] = True
                        raise IOError('simulated interruption')
                    if self.pos > self.end: return b''
                    piece = DATA[self.pos:min(self.pos+n,self.end+1)]
                    self.pos += len(piece)
                    if mode == 'cancel':
                        with open(cancel, 'w') as f: f.write('cancel')
                    return piece
            def opener(req, timeout):
                r = req.get_header('Range')
                match = re.match(r'bytes=(\d+)-(\d*)', r or '')
                start = int(match[1]) if match else 0
                end = min(int(match[2]),len(DATA)-1) if match and match[2] else len(DATA)-1
                calls.append((start,end))
                return Response(start,end)
            original = d.make_opener
            old_sleep = d.time.sleep
            old_argv = sys.argv
            d.make_opener = lambda _: (opener, 'offline_mock')
            d.time.sleep = lambda _: None
            sys.argv = ['download', '-', 'https://offline.invalid/media', out, '--size', str(len(DATA) if known else 0), '--chunk-mb', '1', '--progress-file', progress, '--cancel-file', cancel]
            try:
                with contextlib.redirect_stdout(io.StringIO()): code = d.main()
                with open(out, 'rb') as f: actual = f.read()
                if mode == 'cancel':
                    self.assertEqual(code,130)
                    self.assertEqual(actual,DATA[:len(actual)])
                    self.assertLessEqual(len(actual),d.READ_PIECE)
                elif mode in ('empty','bad-range'):
                    self.assertEqual(code,1)
                    self.assertEqual(actual,b'')
                    self.assertLessEqual(len(calls),d.MAX_RETRY)
                else:
                    self.assertEqual(code,0)
                    self.assertEqual(actual,DATA)
                    import json
                    with open(progress) as f: self.assertEqual(json.load(f)['written'],len(DATA))
                self.assertTrue(all(n <= 64*1024 for n in reads))
            finally:
                d.make_opener = original
                d.time.sleep = old_sleep
                sys.argv = old_argv
    def test_range(self): self.run_case()
    def test_resume(self): self.run_case(resume=123456)
    def test_partial_retry(self): self.run_case('drop')
    def test_ignored_range(self): self.run_case('ignore',resume=123456)
    def test_unknown_size(self): self.run_case('unknown',known=False)
    def test_empty_is_bounded(self): self.run_case('empty')
    def test_reject_wrong_range(self): self.run_case('bad-range')
    def test_cancel_mid_chunk(self): self.run_case('cancel')

if __name__ == '__main__': unittest.main()
