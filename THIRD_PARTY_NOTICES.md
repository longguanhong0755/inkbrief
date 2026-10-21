# Third-party notices

inkbrief 的绘制引擎来自 image2strokes，手写字体来自 Google Fonts，语音合成用 Piper 模型 + onnxruntime-web。各许可证都要求保留版权与许可声明。

## 目录

| 组件 | 位置 | 许可 |
|---|---|---|
| image2strokes | `js/vendor/pipeline.js` | MIT |
| onnxruntime-web | `js/vendor/ort/` | MIT |
| pinyin-pro | `js/vendor/pinyin-pro.min.js` | MIT |
| Piper 中文音色 zh_CN-huayan x_low | `assets/tts/` | MIT |
| Ma Shan Zheng 字体 | `assets/fonts/` | SIL OFL 1.1 |
| espeak-ng（**仅开发期**，不随产品分发） | — | GPL-3.0 |

## image2strokes（vendored 在 `js/vendor/pipeline.js`）

Source: <https://github.com/longguanhong0755/image2strokes>

```
MIT License

Copyright (c) 2026 image2strokes contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`js/vendor/pipeline.js` 只做了两件事：文件头加了这段署名；其余保持 v20（commit `5cf7fea`）原样。

## onnxruntime-web（`js/vendor/ort/`）

- Source: <https://github.com/microsoft/onnxruntime>
- License: MIT，Copyright (c) Microsoft Corporation
- 使用 1.20.1 的 `ort.wasm.min.js` + `ort-wasm-simd-threaded.wasm` / `.mjs`，未修改，只做本地托管（不走 CDN，避免离线不可用）。

## pinyin-pro（`js/vendor/pinyin-pro.min.js`）

- Source: <https://github.com/zh-lx/pinyin-pro>
- License: MIT
- 用途：把中文按词组转拼音（判多音字），再查音素表。

## Piper 中文音色 zh_CN-huayan x_low（`assets/tts/zh-huayan-fp16.onnx`）

- Source: <https://huggingface.co/rhasspy/piper-voices>（`zh/zh_CN/huayan/x_low`）
- License: MIT（Piper voices 仓库整体为 MIT；huayan 音色由该仓库分发）
- 本仓库内的文件是原版 fp32 模型（19.7MB）转 fp16 的结果（10.1MB）：体积减半、速度不变，波形相关 0.998、SNR 23.9dB。转换脚本见 `dev/` 下的生成链。
- `assets/tts/zh-huayan.json` 是同目录原始 config（含音素表），未修改。

## espeak-ng（仅开发期，不随产品分发）

- Source: <https://github.com/espeak-ng/espeak-ng>
- License: GPL-3.0
- 用途：**离线**把汉字转成 IPA，生成 `assets/tts/zh-phonemes.json` 这张 1286 条的映射表。运行时不加载、不分发 espeak 的任何代码或数据，因此产品本体仍是 MIT。
- 复现方式：`npm run tts:chars && npm run tts:phonemes && npm run tts:table`，需要 `@echogarden/espeak-ng-emscripten`。

## Ma Shan Zheng（`assets/fonts/MaShanZheng-Regular.ttf`）

- Family: Ma Shan Zheng / 马善政毛笔楷书
- Copyright 2018 The MaShanZheng Project Authors
  (<https://github.com/googlefonts/mashanzheng>)
- License: SIL Open Font License 1.1
- 完整许可证正文：`assets/fonts/OFL.txt`
- 字体文件来源：Google Fonts（`fonts.gstatic.com`），未做子集化或字形修改。
- `assets/fonts/MaShanZheng-Regular.woff2` 由同目录 TTF 无损转码（仅格式转换），`@font-face` 优先加载 WOFF2，TTF 作兼容兜底。
