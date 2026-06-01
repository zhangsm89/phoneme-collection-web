from __future__ import annotations

import base64
import io
import json
import mimetypes
import re
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA = ROOT / "data"
AUDIO = DATA / "audio"
SESSION_ROOT = DATA / "sessions"
SUBJECTS_FILE = DATA / "subjects.jsonl"
SESSIONS_FILE = DATA / "sessions.jsonl"
TRIALS_FILE = DATA / "trials.jsonl"


def ensure_dirs() -> None:
    AUDIO.mkdir(parents=True, exist_ok=True)
    SESSION_ROOT.mkdir(parents=True, exist_ok=True)
    DATA.mkdir(parents=True, exist_ok=True)


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def read_json(handler: BaseHTTPRequestHandler) -> dict:
    length = int(handler.headers.get("Content-Length", "0"))
    raw = handler.rfile.read(length)
    if not raw:
        return {}
    return json.loads(raw.decode("utf-8"))


def append_jsonl(path: Path, record: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False) + "\n")


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows: list[dict] = []
    with path.open("r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    return rows


def safe_name(value: str) -> str:
    value = re.sub(r"[^A-Za-z0-9_.-]+", "_", value)
    return value.strip("._") or "record"


def audio_extension(mime_type: str) -> str:
    if "wav" in mime_type:
        return "wav"
    if "mp4" in mime_type or "m4a" in mime_type:
        return "m4a"
    if "ogg" in mime_type:
        return "ogg"
    return "webm"


def session_dir(subject_id: str, session_id: str) -> Path:
    return SESSION_ROOT / safe_name(subject_id) / safe_name(session_id)


def manifest_path(subject_id: str, session_id: str) -> Path:
    return session_dir(subject_id, session_id) / "manifest.json"


def load_manifest(subject_id: str, session_id: str) -> dict:
    path = manifest_path(subject_id, session_id)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {
        "subject_id": subject_id,
        "session_id": session_id,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "updated_at": None,
        "trials": {},
    }


def save_manifest(manifest: dict) -> None:
    path = manifest_path(manifest["subject_id"], manifest["session_id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    manifest["updated_at"] = datetime.now().isoformat(timespec="seconds")
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def upsert_manifest_trial(record: dict) -> None:
    manifest = load_manifest(record["subject_id"], record["session_id"])
    manifest["trials"][record["trial_id"]] = record
    save_manifest(manifest)


def all_manifest_trials() -> list[dict]:
    rows: list[dict] = []
    for path in SESSION_ROOT.glob("*/*/manifest.json"):
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
            rows.extend(manifest.get("trials", {}).values())
        except Exception:
            continue
    return rows


def all_sessions_index() -> list[dict]:
    rows: list[dict] = []
    for path in SESSION_ROOT.glob("*/*/manifest.json"):
        try:
            manifest = json.loads(path.read_text(encoding="utf-8"))
            trials = list(manifest.get("trials", {}).values())
            rows.append(
                {
                    "subject_id": manifest.get("subject_id"),
                    "session_id": manifest.get("session_id"),
                    "created_at": manifest.get("created_at"),
                    "updated_at": manifest.get("updated_at"),
                    "finalized_at": manifest.get("finalized_at"),
                    "trial_count": len([t for t in trials if not t.get("deleted")]),
                    "deleted_count": len([t for t in trials if t.get("deleted")]),
                    "manifest_path": str(path.relative_to(DATA)).replace("\\", "/"),
                }
            )
        except Exception:
            continue
    return sorted(rows, key=lambda row: (row.get("updated_at") or row.get("created_at") or ""), reverse=True)


def trial_word_dir(payload: dict) -> Path:
    word_key = f"{safe_name(str(payload.get('stimulus_id') or payload.get('word_index') or payload.get('word') or 'word'))}_{safe_name(str(payload.get('pinyin') or 'reading'))}"
    return session_dir(payload["subject_id"], payload["session_id"]) / "audio" / word_key


def trim_silence(sound):
    import numpy as np
    import parselmouth

    values = sound.values[0]
    if values.size == 0:
        return sound
    peak = float(np.max(np.abs(values)))
    if peak <= 0:
        return sound
    threshold = max(peak * 0.03, 0.005)
    active = np.where(np.abs(values) >= threshold)[0]
    if active.size == 0:
        return sound
    pad = int(0.05 * sound.sampling_frequency)
    start = max(0, int(active[0]) - pad)
    end = min(values.size, int(active[-1]) + pad)
    if end <= start:
        return sound
    trimmed = values[start:end]
    return parselmouth.Sound(trimmed, sampling_frequency=sound.sampling_frequency)


def generate_spectrogram_png(wav_path: Path) -> bytes:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    import numpy as np
    import parselmouth

    sound = trim_silence(parselmouth.Sound(str(wav_path)))
    spectrogram = sound.to_spectrogram(window_length=0.005, maximum_frequency=8000)
    values = spectrogram.values
    values_db = 10 * np.log10(np.maximum(values, 1e-12))
    times = spectrogram.xs()
    freqs = spectrogram.ys()

    formant = sound.to_formant_burg(time_step=0.01, max_number_of_formants=5, maximum_formant=5500)
    formant_times = np.arange(0, sound.duration, 0.01)

    fig, ax = plt.subplots(figsize=(10, 3.8), dpi=140)
    ax.imshow(
        values_db,
        origin="lower",
        aspect="auto",
        extent=[times[0], times[-1], freqs[0], freqs[-1]],
        cmap="magma",
    )
    colors = ["#5cf2ff", "#61ff86", "#ffe45c"]
    for idx, color in zip([1, 2, 3], colors):
        y = [formant.get_value_at_time(idx, float(t)) for t in formant_times]
        ax.plot(formant_times, y, ".", color=color, markersize=2.4, label=f"F{idx}")
    ax.set_xlabel("Time (s)")
    ax.set_ylabel("Frequency (Hz)")
    ax.set_ylim(0, 5500)
    ax.legend(loc="upper right", frameon=True, fontsize=8)
    ax.set_title("Spectrogram with formant tracks")
    fig.tight_layout()
    buf = io.BytesIO()
    fig.savefig(buf, format="png")
    plt.close(fig)
    return buf.getvalue()


def public_file(path: str) -> Path | None:
    route = unquote(urlparse(path).path)
    if route == "/":
        route = "/index.html"
    candidate = (PUBLIC / route.lstrip("/")).resolve()
    if PUBLIC.resolve() not in candidate.parents and candidate != PUBLIC.resolve():
        return None
    return candidate


class Handler(BaseHTTPRequestHandler):
    server_version = "PhonemeCollector/0.1"

    def log_message(self, format: str, *args) -> None:
        timestamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{timestamp}] {self.address_string()} {format % args}")

    def do_GET(self) -> None:
        if self.path.startswith("/api/stimuli"):
            data = json.loads((DATA / "stimuli.json").read_text(encoding="utf-8"))
            json_response(self, 200, {"stimuli": data})
            return
        if self.path.startswith("/api/records"):
            try:
                trials = all_manifest_trials()
                if not trials:
                    trials = load_jsonl(TRIALS_FILE)
                json_response(
                    self,
                    200,
                    {
                        "subjects": load_jsonl(SUBJECTS_FILE),
                        "sessions": load_jsonl(SESSIONS_FILE),
                        "trials": trials,
                    },
                )
            except Exception as exc:
                json_response(self, 500, {"error": "records_error", "detail": str(exc)})
            return
        if self.path.startswith("/api/sessions_index"):
            json_response(self, 200, {"sessions": all_sessions_index()})
            return
        if self.path.startswith("/api/spectrogram"):
            query = parse_qs(urlparse(self.path).query)
            subject_id = query.get("subject_id", [""])[0]
            session_id = query.get("session_id", [""])[0]
            trial_id = query.get("trial_id", [""])[0]
            manifest = load_manifest(subject_id, session_id)
            trial = manifest.get("trials", {}).get(trial_id)
            if not trial or not trial.get("wav_path"):
                json_response(self, 404, {"error": "trial_wav_not_found"})
                return
            wav_path = (DATA / trial["wav_path"]).resolve()
            if DATA.resolve() not in wav_path.parents or not wav_path.exists():
                json_response(self, 404, {"error": "wav_not_found"})
                return
            png_path = session_dir(subject_id, session_id) / "spectrograms" / f"{safe_name(trial_id)}_trimmed.png"
            png_path.parent.mkdir(parents=True, exist_ok=True)
            if not png_path.exists() or png_path.stat().st_mtime < wav_path.stat().st_mtime:
                png_path.write_bytes(generate_spectrogram_png(wav_path))
            body = png_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/file/"):
            rel = unquote(urlparse(self.path).path.removeprefix("/file/"))
            candidate = (DATA / rel).resolve()
            if DATA.resolve() not in candidate.parents or not candidate.exists():
                json_response(self, 404, {"error": "file_not_found"})
                return
            body = candidate.read_bytes()
            content_type = mimetypes.guess_type(candidate.name)[0] or "application/octet-stream"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/audio/"):
            rel = unquote(urlparse(self.path).path.removeprefix("/audio/"))
            candidate = (AUDIO / rel).resolve()
            if AUDIO.resolve() not in candidate.parents or not candidate.exists():
                json_response(self, 404, {"error": "audio_not_found"})
                return
            body = candidate.read_bytes()
            content_type = mimetypes.guess_type(candidate.name)[0] or "audio/webm"
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        file_path = public_file(self.path)
        if not file_path or not file_path.exists() or file_path.is_dir():
            json_response(self, 404, {"error": "not_found"})
            return
        body = file_path.read_bytes()
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        if file_path.suffix == ".js":
            content_type = "text/javascript; charset=utf-8"
        elif file_path.suffix in {".html", ".css"}:
            content_type += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        try:
            if self.path == "/api/subjects":
                payload = read_json(self)
                payload["created_at"] = datetime.now().isoformat(timespec="seconds")
                append_jsonl(SUBJECTS_FILE, payload)
                json_response(self, 200, {"ok": True, "subject": payload})
                return
            if self.path == "/api/sessions":
                payload = read_json(self)
                payload["created_at"] = datetime.now().isoformat(timespec="seconds")
                append_jsonl(SESSIONS_FILE, payload)
                manifest = load_manifest(payload["subject_id"], payload["session_id"])
                manifest["session_metadata"] = payload
                save_manifest(manifest)
                json_response(self, 200, {"ok": True, "session": payload})
                return
            if self.path == "/api/trials":
                payload = read_json(self)
                audio = payload.pop("audio_base64", "")
                wav = payload.pop("wav_base64", "")
                mime_type = payload.get("mime_type", "audio/webm")
                ext = audio_extension(mime_type)
                trial_id = safe_name(payload.get("trial_id", f"trial_{datetime.now().timestamp()}"))
                payload["trial_id"] = trial_id
                payload.setdefault("subject_id", "subject")
                payload.setdefault("session_id", "session")
                word_dir = trial_word_dir(payload)
                word_dir.mkdir(parents=True, exist_ok=True)
                audio_path = word_dir / f"{trial_id}.{ext}"
                if audio:
                    audio_path.write_bytes(base64.b64decode(audio))
                    payload["audio_path"] = str(audio_path.relative_to(DATA)).replace("\\", "/")
                if wav:
                    wav_path = word_dir / f"{trial_id}.wav"
                    wav_path.write_bytes(base64.b64decode(wav))
                    payload["wav_path"] = str(wav_path.relative_to(DATA)).replace("\\", "/")
                payload["expected_reading"] = {
                    "word": payload.get("word"),
                    "pinyin": payload.get("pinyin"),
                    "initial": payload.get("target_initial"),
                    "final": payload.get("target_final"),
                    "tone": payload.get("target_tone"),
                }
                payload.setdefault("perceived_reading", {})
                payload.setdefault("annotation", {})
                payload["saved_at"] = datetime.now().isoformat(timespec="seconds")
                append_jsonl(TRIALS_FILE, payload)
                upsert_manifest_trial(payload)
                json_response(self, 200, {"ok": True, "trial": payload})
                return
            if self.path == "/api/annotations":
                payload = read_json(self)
                manifest = load_manifest(payload["subject_id"], payload["session_id"])
                trial = manifest.get("trials", {}).get(payload["trial_id"])
                if not trial:
                    json_response(self, 404, {"error": "trial_not_found"})
                    return
                trial["perceived_reading"] = payload.get("perceived_reading", {})
                trial["therapist_transcription"] = payload.get("therapist_transcription", "")
                trial["error_type"] = payload.get("error_type", "")
                trial["error_types"] = payload.get("error_types", [])
                trial["annotation"] = payload.get("annotation", {})
                trial["adjudication"] = payload.get("adjudication", {})
                trial["label_updated_at"] = datetime.now().isoformat(timespec="seconds")
                upsert_manifest_trial(trial)
                append_jsonl(TRIALS_FILE, {"event": "annotation", **trial})
                json_response(self, 200, {"ok": True, "trial": trial})
                return
            if self.path == "/api/finalize_session":
                payload = read_json(self)
                manifest = load_manifest(payload["subject_id"], payload["session_id"])
                manifest["finalized_at"] = datetime.now().isoformat(timespec="seconds")
                manifest["finalized_by"] = payload.get("finalized_by", "")
                save_manifest(manifest)
                json_response(self, 200, {"ok": True, "manifest": manifest})
                return
            if self.path == "/api/delete_trial":
                payload = read_json(self)
                manifest = load_manifest(payload["subject_id"], payload["session_id"])
                trial = manifest.get("trials", {}).get(payload["trial_id"])
                if not trial:
                    json_response(self, 404, {"error": "trial_not_found"})
                    return
                for key in ["audio_path", "wav_path"]:
                    if trial.get(key):
                        path = (DATA / trial[key]).resolve()
                        if DATA.resolve() in path.parents and path.exists():
                            path.unlink()
                trial["deleted"] = True
                trial["delete_reason"] = payload.get("reason", "建议重录")
                trial["deleted_at"] = datetime.now().isoformat(timespec="seconds")
                upsert_manifest_trial(trial)
                append_jsonl(TRIALS_FILE, {"event": "delete_trial", **trial})
                json_response(self, 200, {"ok": True, "trial": trial})
                return
            json_response(self, 404, {"error": "not_found"})
        except Exception as exc:
            json_response(self, 500, {"error": "server_error", "detail": str(exc)})


if __name__ == "__main__":
    ensure_dirs()
    host = "127.0.0.1"
    port = 8765
    print(f"Serving phoneme collection app at http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
