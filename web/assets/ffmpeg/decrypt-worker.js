// 浏览器端 WASM 解密：fetch 原始 mp4 → ffmpeg -decryption_key → fMP4
importScripts('ffmpeg-core.js');

let corePromise = null;
function getCore() {
  if (!corePromise) {
    corePromise = (async () => {
      const wasm = await (await fetch('ffmpeg-core.wasm')).arrayBuffer();
      return createFFmpegCore({ wasmBinary: wasm, locateFile: (f) => f, print() {}, printErr() {} });
    })();
  }
  return corePromise;
}

self.onmessage = async (event) => {
  const { id, url, key } = event.data || {};
  try {
    const resp = await fetch(url, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!resp.ok) throw new Error('下载失败 HTTP ' + resp.status);
    const input = new Uint8Array(await resp.arrayBuffer());
    if (input.length > 240 * 1024 * 1024) throw new Error('文件过大（' + Math.round(input.length / 1048576) + 'MB），已切回中转播放');
    const core = await getCore();
    for (const name of ['in.mp4', 'out.mp4']) { try { core.FS.unlink(name); } catch (e) {} }
    core.FS.writeFile('in.mp4', input);
    core.exec('-decryption_key', key, '-i', 'in.mp4', '-c', 'copy', '-tag:v', 'hvc1',
      '-movflags', 'frag_keyframe+empty_moov', 'out.mp4');
    const out = core.FS.readFile('out.mp4');
    self.postMessage({ id, ok: true, size: out.length, data: out.buffer }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
