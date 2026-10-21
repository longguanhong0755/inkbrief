# TTS 选型实测报告

> 日期：2026-10-21
> 目的：为 inkbrief 多图版挑选「单语言 < 10MB、纯浏览器、可参数化」的本地 TTS
> 测试机：Windows / Chrome 155 headless / onnxruntime-web 1.20.1（WASM 后端，单线程）

## 一句话结论

**现成的没有；自己转 fp16 能刚好卡进 10MB。中文可行，英文是短板。**

## 实测数据

| 方案 | 体积 | 浏览器能跑 | 推理速度 | 音质（对 fp32） |
|---|---|---|---|---|
| Piper zh_CN-huayan-x_low **fp32** | 19.67 MB | 是 | RTF 0.384 | 基准 |
| Piper zh_CN-huayan-x_low **fp16** | **10.13 MB** | 是 | RTF 0.380 | 相关 0.994 / SNR 23.9 dB |
| Piper zh_CN-huayan-x_low **int8** | 7.59 MB | **否** | — | — |
| Piper zh_CN-huayan-medium fp32 | 60.27 MB | 是 | — | 更好 |
| Piper en_US-amy-low fp32 | 60.18 MB | 是 | — | 好 |
| Piper en_US-amy-low fp16 | ≈30.09 MB | 是 | — | 好 |
| Kitten TTS nano fp32 | 22.74 MB | 未测 | — | 未测 |
| Inflect Nano v2 fp16 | ≈7.73 MB | 未测 | — | 未测 |

RTF = 合成耗时 / 音频时长。0.38 表示比实时快 2.6 倍。

## 三条硬事实

### 1. int8 量化在浏览器里根本跑不起来

`quantize_dynamic` 能把 19.67MB 压到 7.59MB，但加载直接报错：

```
Can't create a session. ERROR_CODE: 9,
Could not find an implementation for ConvInteger(10) node
```

onnxruntime-web 的 WASM 后端没有 int8 卷积实现。**这条路过不去，不用再试。**

顺带一提：int8 在原生 CPU 上也让推理慢了 10 倍（RTF 0.09 → 0.90），本身就不可取。

### 2. fp16 是唯一可行的小体积路线

- 体积精确减半，速度不变（甚至略快，因为访存减半）
- 音质与 fp32 波形相关 0.994、SNR 23.9 dB，人耳不可辨
- 浏览器 WASM 原生支持

### 3. 10MB 是这个模型的物理下限

huayan-x_low 有 **5.0M 参数**，fp16 每参数 2 字节 → 10MB 整，加上图结构开销 10.13MB。
想更小只能换参数更少的模型，没有别的技巧。

## 中文的隐藏成本：音素词典

模型音素表是 espeak 的 IPA（130 个符号，如 `ɕ` `ʈʂ` `ɑ`），不是拼音。
需要一个「汉字 → 音素序列」的映射。两条路：

1. 打包 espeak-ng WASM（约 2–3MB）—— 重，且引入第二个运行时
2. 从模型自带数据离线生成词典，只保留常用字 —— 约 0.5MB，可直接查表

推荐第 2 条。**中文实际下载 ≈ 10.6MB。**

## 英文的问题

Piper 官方 177 个音色里，**英文一个 x_low 档都没有**，最小就是 60MB 的 low 档，fp16 后 30MB。
要压进 10MB 只能换架构不同的模型（Inflect Nano / Kitten nano），但那需要另写一套文本前端和推理管线，音质未验证。

## 待定

- 英文走 30MB（Piper，音质稳）还是 ≈7.7MB（Inflect Nano，需继续验证）
- 是否需要多音色：每个音色是一份独立模型，n 个音色 = n 份体积。需求里说的「几种现成音色」与「<10MB」在体积上互相冲突

## 复现方式

```bash
# 下载模型（HF 直连不通，用镜像）
curl -L "https://hf-mirror.com/rhasspy/piper-voices/resolve/main/zh/zh_CN/huayan/x_low/zh_CN-huayan-x_low.onnx" -o zh_fp32.onnx

# 量化（需要 Python 3.12 + onnx + onnxruntime，PyPI 官方源不通时用阿里云镜像）
python -c "
import onnx
from onnxruntime.transformers.float16 import convert_float_to_float16
m = onnx.load('zh_fp32.onnx')
onnx.save(convert_float_to_float16(m, keep_io_types=True, disable_shape_infer=True), 'zh_fp16.onnx')
"

# 浏览器实测
node dev/test_ort_browser.mjs
```
