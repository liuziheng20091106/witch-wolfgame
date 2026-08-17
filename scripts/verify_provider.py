#!/usr/bin/env python3
"""OpenAI 兼容模型提供商验证器。"""

from __future__ import annotations

import json
import queue
import threading
import tkinter as tk
from dataclasses import dataclass
from tkinter import messagebox, ttk
from tkinter.scrolledtext import ScrolledText
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import SplitResult, urlsplit, urlunsplit
from urllib.request import Request, urlopen

APP_TITLE = "模型提供商验证器"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


@dataclass(frozen=True)
class HttpResult:
    status: int | None
    body: Any | None
    text: str
    error: str | None

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300


def normalize_endpoints(endpoint: str) -> tuple[str, str]:
    """接受 API 根地址、/v1 或完整 Chat Completions 地址。"""
    value = endpoint.strip()
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("端点必须是以 http:// 或 https:// 开头的完整 URL")
    if parsed.query or parsed.fragment:
        raise ValueError("端点不能包含查询参数或片段")

    path = parsed.path.rstrip("/")
    if path.endswith("/chat/completions"):
        chat_path = path
    elif path.endswith("/models"):
        chat_path = f"{path.removesuffix('/models')}/chat/completions"
    elif path:
        chat_path = f"{path}/chat/completions"
    else:
        chat_path = "/v1/chat/completions"

    chat_endpoint = urlunsplit(SplitResult(parsed.scheme, parsed.netloc, chat_path, "", ""))
    models_endpoint = f"{chat_endpoint.removesuffix('/chat/completions')}/models"
    return chat_endpoint, models_endpoint


def read_response(response: Any, status: int) -> HttpResult:
    raw = response.read(MAX_RESPONSE_BYTES + 1)
    if len(raw) > MAX_RESPONSE_BYTES:
        return HttpResult(status, None, "", "响应体超过 2 MiB 限制")

    text = raw.decode("utf-8", errors="replace")
    try:
        return HttpResult(status, json.loads(text), text, None)
    except json.JSONDecodeError:
        return HttpResult(status, None, text, None)


def request_json(
    method: str,
    url: str,
    api_key: str,
    timeout: float,
    payload: dict[str, Any] | None = None,
) -> HttpResult:
    headers = {
        "Accept": "application/json",
        "Authorization": f"Bearer {api_key}",
        "User-Agent": "MajoWolfProviderVerifier/1.0",
    }
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"

    try:
        request = Request(url, data=data, headers=headers, method=method)
        with urlopen(request, timeout=timeout) as response:
            return read_response(response, response.status)
    except HTTPError as error:
        return read_response(error, error.code)
    except (URLError, OSError, ValueError) as error:
        return HttpResult(None, None, "", str(error))


def parse_model_ids(body: Any) -> list[str] | None:
    if not isinstance(body, dict) or not isinstance(body.get("data"), list):
        return None
    ids = [entry.get("id") for entry in body["data"] if isinstance(entry, dict) and isinstance(entry.get("id"), str)]
    return sorted(set(ids))


def extract_message_content(body: Any) -> tuple[str | None, str | None]:
    if not isinstance(body, dict):
        return None, "响应不是 JSON 对象"
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return None, "响应缺少 choices[0]"
    message = choices[0].get("message")
    if not isinstance(message, dict) or not isinstance(message.get("content"), str):
        return None, "响应缺少 choices[0].message.content 字符串"
    return message["content"], None


def parse_json_object(content: str) -> tuple[bool, str | None]:
    try:
        value = json.loads(content)
    except json.JSONDecodeError as error:
        return False, f"内容不是合法 JSON：{error.msg}"
    if not isinstance(value, dict):
        return False, "内容是 JSON，但不是对象"
    return True, None


def compact_detail(result: HttpResult, api_key: str) -> str:
    if result.error:
        detail = result.error
    elif result.body is not None:
        detail = json.dumps(result.body, ensure_ascii=False)
    else:
        detail = result.text
    return detail.replace(api_key, "[已隐藏]").replace("\n", " ").strip()[:600] or "服务未提供错误详情"


def status_text(result: HttpResult, api_key: str) -> str:
    if result.ok:
        return f"HTTP {result.status}"
    if result.status is not None:
        return f"HTTP {result.status}；{compact_detail(result, api_key)}"
    return f"网络错误；{compact_detail(result, api_key)}"


class ProviderVerifierApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self.minsize(820, 650)
        self.geometry("920x720")
        self.event_queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self.busy = False

        self.endpoint_var = tk.StringVar(value="https://api.openai.com/v1/chat/completions")
        self.api_key_var = tk.StringVar()
        self.model_var = tk.StringVar()
        self.timeout_var = tk.StringVar(value="30")
        self.models_status_var = tk.StringVar(value="未检测")
        self.normal_status_var = tk.StringVar(value="未检测")
        self.json_status_var = tk.StringVar(value="未检测")

        self._build_ui()
        self.after(100, self._process_events)

    def _build_ui(self) -> None:
        self.columnconfigure(0, weight=1)
        self.rowconfigure(3, weight=1)

        form = ttk.LabelFrame(self, text="连接设置", padding=14)
        form.grid(row=0, column=0, sticky="ew", padx=16, pady=(16, 8))
        form.columnconfigure(1, weight=1)

        ttk.Label(form, text="Chat Completions 端点").grid(row=0, column=0, sticky="w", padx=(0, 10), pady=5)
        ttk.Entry(form, textvariable=self.endpoint_var).grid(row=0, column=1, columnspan=3, sticky="ew", pady=5)

        ttk.Label(form, text="API Key").grid(row=1, column=0, sticky="w", padx=(0, 10), pady=5)
        ttk.Entry(form, textvariable=self.api_key_var, show="*").grid(row=1, column=1, columnspan=3, sticky="ew", pady=5)

        ttk.Label(form, text="指定模型").grid(row=2, column=0, sticky="w", padx=(0, 10), pady=5)
        self.model_box = ttk.Combobox(form, textvariable=self.model_var)
        self.model_box.grid(row=2, column=1, sticky="ew", pady=5)
        ttk.Label(form, text="超时（秒）").grid(row=2, column=2, sticky="e", padx=(12, 8), pady=5)
        ttk.Spinbox(form, from_=1, to=300, textvariable=self.timeout_var, width=7).grid(row=2, column=3, sticky="w", pady=5)

        actions = ttk.Frame(self, padding=(16, 0))
        actions.grid(row=1, column=0, sticky="ew", pady=8)
        self.fetch_button = ttk.Button(actions, text="拉取模型列表", command=self.start_fetch_models)
        self.fetch_button.pack(side="left")
        self.verify_button = ttk.Button(actions, text="一键拉取并验证", command=self.start_verify)
        self.verify_button.pack(side="left", padx=8)
        ttk.Button(actions, text="清空日志", command=self.clear_log).pack(side="left")
        ttk.Label(actions, text="API Key 仅用于本次请求，不会写入日志或磁盘。", foreground="#666666").pack(side="right")

        result = ttk.LabelFrame(self, text="验证结果", padding=12)
        result.grid(row=2, column=0, sticky="ew", padx=16, pady=(0, 8))
        result.columnconfigure(1, weight=1)
        rows = [
            ("模型列表 / 指定模型", self.models_status_var),
            ("普通 Chat Completions", self.normal_status_var),
            ("JSON 格式输出", self.json_status_var),
        ]
        for index, (label, value) in enumerate(rows):
            ttk.Label(result, text=label).grid(row=index, column=0, sticky="w", padx=(0, 14), pady=3)
            ttk.Label(result, textvariable=value, wraplength=680).grid(row=index, column=1, sticky="w", pady=3)

        log_frame = ttk.LabelFrame(self, text="请求日志", padding=8)
        log_frame.grid(row=3, column=0, sticky="nsew", padx=16, pady=(0, 16))
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)
        self.log_box = ScrolledText(log_frame, height=18, state="disabled", wrap="word", font=("Consolas", 10))
        self.log_box.grid(row=0, column=0, sticky="nsew")
        self.log("准备就绪：填写端点与 API Key，先拉取模型或直接验证指定模型。")

    def log(self, message: str) -> None:
        self.log_box.configure(state="normal")
        self.log_box.insert("end", f"{message}\n")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    def clear_log(self) -> None:
        self.log_box.configure(state="normal")
        self.log_box.delete("1.0", "end")
        self.log_box.configure(state="disabled")

    def collect_inputs(self, require_model: bool) -> tuple[str, str, str, str, float] | None:
        endpoint = self.endpoint_var.get().strip()
        api_key = self.api_key_var.get().strip()
        model = self.model_var.get().strip()
        if not endpoint:
            messagebox.showerror(APP_TITLE, "请填写 Chat Completions 端点。")
            return None
        if not api_key:
            messagebox.showerror(APP_TITLE, "请填写 API Key。")
            return None
        if require_model and not model:
            messagebox.showerror(APP_TITLE, "请先填写或从模型列表选择要验证的模型。")
            return None
        try:
            timeout = float(self.timeout_var.get())
            if timeout <= 0:
                raise ValueError
            chat_endpoint, models_endpoint = normalize_endpoints(endpoint)
        except ValueError as error:
            messagebox.showerror(APP_TITLE, f"输入无效：{error}")
            return None
        return chat_endpoint, models_endpoint, api_key, model, timeout

    def set_busy(self, busy: bool) -> None:
        self.busy = busy
        state = "disabled" if busy else "normal"
        self.fetch_button.configure(state=state)
        self.verify_button.configure(state=state)

    def start_fetch_models(self) -> None:
        inputs = self.collect_inputs(require_model=False)
        if inputs is None or self.busy:
            return
        chat_endpoint, models_endpoint, api_key, _, timeout = inputs
        self.set_busy(True)
        self.log(f"拉取模型列表：{models_endpoint}")
        threading.Thread(target=self.fetch_models_worker, args=(models_endpoint, api_key, timeout, None), daemon=True).start()

    def start_verify(self) -> None:
        inputs = self.collect_inputs(require_model=True)
        if inputs is None or self.busy:
            return
        chat_endpoint, models_endpoint, api_key, model, timeout = inputs
        self.set_busy(True)
        self.models_status_var.set("检测中…")
        self.normal_status_var.set("检测中…")
        self.json_status_var.set("检测中…")
        self.log(f"开始验证模型：{model}")
        self.log(f"Chat Completions：{chat_endpoint}")
        threading.Thread(target=self.verify_worker, args=(chat_endpoint, models_endpoint, api_key, model, timeout), daemon=True).start()

    def fetch_models_worker(self, models_endpoint: str, api_key: str, timeout: float, selected_model: str | None) -> None:
        try:
            result = request_json("GET", models_endpoint, api_key, timeout)
            self.event_queue.put(("models", (result, parse_model_ids(result.body) if result.ok else None, selected_model, api_key)))
        except Exception as error:
            self.event_queue.put(("log", f"模型列表请求异常：{error}"))
            self.event_queue.put(("models_status", "失败：模型列表请求出现未处理异常"))
        finally:
            self.event_queue.put(("finished", None))

    def verify_worker(self, chat_endpoint: str, models_endpoint: str, api_key: str, model: str, timeout: float) -> None:
        try:
            models_result = request_json("GET", models_endpoint, api_key, timeout)
            model_ids = parse_model_ids(models_result.body) if models_result.ok else None
            self.event_queue.put(("models", (models_result, model_ids, model, api_key)))

            normal_payload = {
                "model": model,
                "messages": [{"role": "user", "content": "Reply exactly: provider-check-ok"}],
                "max_tokens": 32,
            }
            self.event_queue.put(("log", "测试普通 Chat Completions…"))
            normal_result = request_json("POST", chat_endpoint, api_key, timeout, normal_payload)
            normal_content, normal_error = extract_message_content(normal_result.body) if normal_result.ok else (None, None)
            if normal_result.ok and normal_error is None:
                normal_status = f"通过：{status_text(normal_result, api_key)}，包含 choices[0].message.content"
            elif normal_result.ok:
                normal_status = f"失败：{status_text(normal_result, api_key)}，{normal_error}"
            else:
                normal_status = f"失败：{status_text(normal_result, api_key)}"
            self.event_queue.put(("normal_status", normal_status))

            json_payload = {
                "model": model,
                "messages": [{"role": "user", "content": "只返回 JSON 对象 {\"provider_check\":\"ok\"}，不要 Markdown 或其他文字。"}],
                "max_tokens": 32,
                "response_format": {"type": "json_object"},
            }
            self.event_queue.put(("log", "测试 response_format: json_object…"))
            json_result = request_json("POST", chat_endpoint, api_key, timeout, json_payload)
            json_content, json_error = extract_message_content(json_result.body) if json_result.ok else (None, None)
            if json_result.ok and json_error is None and json_content is not None:
                json_ok, parse_error = parse_json_object(json_content)
                json_status = f"通过：{status_text(json_result, api_key)}，内容可解析为 JSON 对象" if json_ok else f"失败：{status_text(json_result, api_key)}，{parse_error}"
            elif json_result.ok:
                json_status = f"失败：{status_text(json_result, api_key)}，{json_error}"
            else:
                json_status = f"失败：{status_text(json_result, api_key)}"
            self.event_queue.put(("json_status", json_status))
        except Exception as error:
            self.event_queue.put(("log", f"验证异常：{error}"))
            self.event_queue.put(("normal_status", "失败：请求出现未处理异常"))
            self.event_queue.put(("json_status", "失败：请求出现未处理异常"))
        finally:
            self.event_queue.put(("finished", None))

    def _apply_models_result(self, result: HttpResult, model_ids: list[str] | None, selected_model: str | None, api_key: str) -> None:
        if not result.ok:
            self.models_status_var.set(f"失败：{status_text(result, api_key)}")
            self.log(f"模型列表失败：{status_text(result, api_key)}")
            return
        if model_ids is None:
            self.models_status_var.set("失败：HTTP 成功，但响应不是包含 data 数组的模型列表")
            self.log("模型列表响应不兼容：未找到 data 数组。")
            return

        self.model_box["values"] = model_ids
        if selected_model:
            if selected_model in model_ids:
                self.models_status_var.set(f"通过：HTTP {result.status}，已加载 {len(model_ids)} 个模型，指定模型存在")
            else:
                self.models_status_var.set(f"未知：HTTP {result.status}，已加载 {len(model_ids)} 个模型，但指定模型未出现；继续以实际请求验证")
        else:
            self.models_status_var.set(f"通过：HTTP {result.status}，已加载 {len(model_ids)} 个模型")
        self.log(f"模型列表成功：{len(model_ids)} 个模型已填入下拉框。")

    def _process_events(self) -> None:
        try:
            while True:
                kind, value = self.event_queue.get_nowait()
                if kind == "log":
                    self.log(value)
                elif kind == "models":
                    self._apply_models_result(*value)
                elif kind == "models_status":
                    self.models_status_var.set(value)
                elif kind == "normal_status":
                    self.normal_status_var.set(value)
                    self.log(value)
                elif kind == "json_status":
                    self.json_status_var.set(value)
                    self.log(value)
                elif kind == "finished":
                    self.set_busy(False)
                    self.log("本次任务结束。")
        except queue.Empty:
            pass
        self.after(100, self._process_events)


def main() -> None:
    app = ProviderVerifierApp()
    app.mainloop()


if __name__ == "__main__":
    main()
