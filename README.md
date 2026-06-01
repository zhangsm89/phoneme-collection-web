
# phoneme-collection-app 音位对比能力数据采集网页
## Webpage for Monosyllable Speech Collection &amp; Annotation

本地运行的“治疗师监督 + 浏览器录音 + 自动质控 + 后台标注”原型。前端使用浏览器麦克风 API，后端使用 Python 标准库保存数据到 `data/`。

## 使用方法
在你想放项目的目录里执行：

```
cd D:\project
git clone https://github.com/zhangsm89/phoneme-collection-web.git
```

进入项目：

```
cd D:\project\phoneme-collection-web
```

运行：

```
python server.py
```

然后浏览器打开：

http://127.0.0.1:8765/

## 数据落盘

- `data/subjects.jsonl`: 匿名被试背景、知情同意、临床背景。
- `data/sessions.jsonl`: session、设备、环境噪声、随机种子。
- `data/trials.jsonl`: 每条音频元数据、质控、治疗师即时标记和后台标注字段。
- `data/sessions/<subject_id>/<session_id>/manifest.json`: 单次实验的权威 manifest，包含每个 trial 的目标发音、感知发音、标注者、复核/仲裁、音频路径和删除状态。
- `data/sessions/<subject_id>/<session_id>/audio/<stimulus_id>_<pinyin>/`: 每个字单独一个文件夹，保存原始浏览器录音和用于声学分析的 WAV。
- `data/sessions/<subject_id>/<session_id>/spectrograms/`: Praat/parselmouth 生成的语谱图缓存。

浏览器通常原始录音为 `webm`，前端会同时解码保存一份 WAV，供 Praat/parselmouth 生成带 F1/F2/F3 共振峰标记的语谱图。
语谱图生成前会基于能量阈值裁掉音频前后的空白段，只影响标注页展示，不改写原始录音文件。

## 语谱图依赖

```powershell
python -m pip install --user numpy matplotlib praat-parselmouth
```
