#!/usr/bin/env python3
"""魔女狼人杀生产服务快速更新工具。"""

from __future__ import annotations

import http.client
import json
import os
import queue
import re
import shlex
import socket
import ssl
import subprocess
import threading
import time
import tkinter as tk
from dataclasses import dataclass
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from tkinter.scrolledtext import ScrolledText
from urllib.parse import urlsplit

APP_TITLE = "魔女狼人杀生产快速更新"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
MAX_RESPONSE_BYTES = 1024 * 1024
MAIN_FILES = (
    "shared/gamePromptContract.js",
    "server/gameProtocol.mjs",
    "server/main.mjs",
    "server/shared.mjs",
)
SSH_TARGET_RE = re.compile(r"^[A-Za-z0-9_.@:-]+$")
REMOTE_PATH_RE = re.compile(r"^/[A-Za-z0-9_./-]+$")


@dataclass(frozen=True)
class Endpoint:
    host: str
    port: int
    path: str


@dataclass(frozen=True)
class HttpResult:
    status: int
    text: str
    body: object | None


class SNIHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, server_name: str, context: ssl.SSLContext, timeout: float) -> None:
        super().__init__(host, port=port, context=context, timeout=timeout)
        self.server_name = server_name

    def connect(self) -> None:
        raw_socket = socket.create_connection((self.host, self.port), self.timeout)
        self.sock = self._context.wrap_socket(raw_socket, server_hostname=self.server_name)


def parse_endpoint(value: str) -> Endpoint:
    parsed = urlsplit(value.strip())
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("更新端点必须是完整的 HTTPS URL")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError("更新端点不能包含身份信息、查询参数或片段")
    path = parsed.path or "/update"
    if path != "/update":
        raise ValueError("更新端点路径必须是 /update")
    return Endpoint(parsed.hostname, parsed.port or 443, path)


def validate_ssh_target(value: str) -> str:
    candidate = value.strip()
    if not SSH_TARGET_RE.fullmatch(candidate):
        raise ValueError("SSH 目标只能包含用户名、主机名、IP、点、冒号、@、下划线和连字符")
    return candidate


def validate_remote_root(value: str) -> str:
    candidate = value.strip().rstrip("/")
    if not REMOTE_PATH_RE.fullmatch(candidate) or ".." in candidate.split("/"):
        raise ValueError("远端根目录必须是不含 .. 的绝对路径")
    return candidate


def read_secret(path: Path) -> str:
    value = path.read_text(encoding="utf-8").strip()
    if len(value) < 32:
        raise ValueError("更新密钥文件内容过短，至少需要 32 个字符")
    return value


def create_tls_context(ca_file: Path, cert_file: Path, key_file: Path) -> ssl.SSLContext:
    for path in (ca_file, cert_file, key_file):
        if not path.is_file():
            raise FileNotFoundError(path)
    context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH, cafile=str(ca_file))
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(str(cert_file), str(key_file))
    return context


def request_proxy(
    connect_host: str,
    endpoint: Endpoint,
    server_name: str,
    context: ssl.SSLContext,
    timeout: float,
    method: str,
    path: str,
    update_pass: str | None = None,
) -> HttpResult:
    connection = SNIHTTPSConnection(connect_host, endpoint.port, server_name, context, timeout)
    headers = {"Accept": "application/json", "Host": server_name, "User-Agent": "MajoWolfQuickUpdate/1.0"}
    if update_pass is not None:
        headers["Authorization"] = f"Bearer {update_pass}"
        headers["Content-Length"] = "0"
    try:
        connection.request(method, path, body=b"" if method == "POST" else None, headers=headers)
        response = connection.getresponse()
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise RuntimeError("服务器响应超过 1 MiB")
        text = raw.decode("utf-8", errors="replace")
        try:
            body = json.loads(text)
        except json.JSONDecodeError:
            body = None
        return HttpResult(response.status, text, body)
    finally:
        connection.close()


def run_checked(args: list[str], timeout: float = 120, input_text: str | None = None) -> str:
    completed = subprocess.run(
        args,
        input=input_text,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or f"退出码 {completed.returncode}"
        raise RuntimeError(f"命令失败：{args[0]}：{detail[:800]}")
    return completed.stdout.strip()


def verify_published_source(project_root: Path) -> str:
    status = run_checked(["git", "status", "--porcelain"], timeout=30, input_text=None) if project_root == Path.cwd() else run_checked(
        ["git", "-C", str(project_root), "status", "--porcelain"], timeout=30
    )
    if status:
        raise RuntimeError("项目存在未提交变更；快速更新只允许使用已推送的干净版本")
    head = run_checked(["git", "-C", str(project_root), "rev-parse", "HEAD"], timeout=30)
    remote = run_checked(["git", "-C", str(project_root), "rev-parse", "origin/main"], timeout=30)
    if head != remote:
        raise RuntimeError("本地 HEAD 与 origin/main 不一致；请先推送 main")
    return head


def run_remote_python(ssh_target: str, script: str, *args: str, timeout: float = 120) -> str:
    return run_checked(["ssh", "-o", "BatchMode=yes", ssh_target, "python3", "-", *args], timeout, script)


def stage_main_files(project_root: Path, ssh_target: str, remote_root: str) -> str:
    create_stage = """
from pathlib import Path
import tempfile, sys
root = Path(sys.argv[1])
backup = root / 'backups'
backup.mkdir(parents=True, exist_ok=True)
print(tempfile.mkdtemp(prefix='quick-update-', dir=backup))
"""
    stage = run_remote_python(ssh_target, create_stage, remote_root).strip()
    if not stage.startswith(f"{remote_root}/backups/quick-update-"):
        raise RuntimeError("远端返回了非法暂存目录")
    prepare_stage = """
from pathlib import Path
import sys
stage = Path(sys.argv[1])
for value in sys.argv[2:]:
    relative = Path(value)
    if relative.is_absolute() or '..' in relative.parts:
        raise RuntimeError('非法相对路径')
    (stage / relative).parent.mkdir(parents=True, exist_ok=True)
"""
    run_remote_python(ssh_target, prepare_stage, stage, *MAIN_FILES)
    for relative in MAIN_FILES:
        run_checked(["scp", "-q", str(project_root / relative), f"{ssh_target}:{stage}/{relative}"], timeout=120)
    return stage


def commit_main_files(ssh_target: str, remote_root: str, stage: str) -> None:
    commit_script = """
from pathlib import Path
import os, subprocess, sys
root = Path(sys.argv[1])
stage = Path(sys.argv[2])
files = sys.argv[3:]
entries = []
try:
    for value in files:
        relative = Path(value)
        if relative.is_absolute() or '..' in relative.parts:
            raise RuntimeError('非法相对路径')
        target = root / 'app' / relative
        incoming = stage / relative
        backup = stage / '.previous' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        backup.parent.mkdir(parents=True, exist_ok=True)
        had_original = target.exists()
        if had_original:
            os.replace(target, backup)
        entries.append((target, backup, had_original, False))
        os.replace(incoming, target)
        entries[-1] = (target, backup, had_original, True)
except Exception:
    for target, backup, had_original, installed in reversed(entries):
        if installed and target.exists():
            target.unlink()
        if had_original and backup.exists():
            os.replace(backup, target)
    raise
subprocess.run(['docker', 'restart', 'majowolf-main'], check=True, stdout=subprocess.DEVNULL)
"""
    run_remote_python(ssh_target, commit_script, remote_root, stage, *MAIN_FILES, timeout=180)


def cleanup_stage(ssh_target: str, stage: str) -> None:
    cleanup_script = """
from pathlib import Path
import shutil, sys
path = Path(sys.argv[1])
if path.name.startswith('quick-update-') and path.parent.name == 'backups':
    shutil.rmtree(path, ignore_errors=True)
"""
    run_remote_python(ssh_target, cleanup_script, stage, timeout=30)


def wait_main_health(ssh_target: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    last_error = ""
    while time.monotonic() < deadline:
        try:
            output = run_checked(
                ["ssh", "-o", "BatchMode=yes", ssh_target, "curl", "-fsS", "http://127.0.0.1:34022/healthz"],
                timeout=10,
            )
            body = json.loads(output)
            if body.get("ok") is True and body.get("service") == "majo-main":
                return
        except (RuntimeError, json.JSONDecodeError) as error:
            last_error = str(error)
        time.sleep(1)
    raise RuntimeError(f"主后端健康检查超时：{last_error}")


class SshTunnel:
    def __init__(self, ssh_target: str, remote_port: int) -> None:
        self.ssh_target = ssh_target
        self.remote_port = remote_port
        self.local_port = 0
        self.process: subprocess.Popen[str] | None = None

    def __enter__(self) -> "SshTunnel":
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            self.local_port = probe.getsockname()[1]
        self.process = subprocess.Popen(
            [
                "ssh", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-N",
                "-L", f"127.0.0.1:{self.local_port}:127.0.0.1:{self.remote_port}", self.ssh_target,
            ],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                detail = self.process.stderr.read().strip() if self.process.stderr else ""
                raise RuntimeError(f"SSH 隧道启动失败：{detail[:800]}")
            try:
                with socket.create_connection(("127.0.0.1", self.local_port), timeout=0.2):
                    return self
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("SSH 隧道启动超时")

    def __exit__(self, *_: object) -> None:
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()


def wait_proxy_health(
    connect_host: str,
    endpoint: Endpoint,
    server_name: str,
    context: ssl.SSLContext,
    timeout: float,
) -> None:
    deadline = time.monotonic() + timeout
    last_error = ""
    while time.monotonic() < deadline:
        try:
            result = request_proxy(connect_host, endpoint, server_name, context, 8, "GET", "/healthz")
            if result.status == 200 and isinstance(result.body, dict) and result.body.get("ok") is True:
                return
            last_error = f"HTTP {result.status}: {result.text[:200]}"
        except (OSError, ssl.SSLError, http.client.HTTPException, RuntimeError) as error:
            last_error = str(error)
        time.sleep(1)
    raise RuntimeError(f"代理健康检查超时：{last_error}")


class QuickUpdateApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self.geometry("900x720")
        self.minsize(820, 650)
        self.events: queue.Queue[tuple[str, object]] = queue.Queue()
        self.busy = False

        self.project_var = tk.StringVar(value=str(PROJECT_ROOT))
        self.endpoint_var = tk.StringVar(value="https://192.144.138.101:34023/update")
        self.proxy_ssh_var = tk.StringVar(value="root@192.144.138.101")
        self.server_name_var = tk.StringVar(value="proxy.internal")
        self.main_ssh_var = tk.StringVar(value="root@192.168.0.109")
        self.main_root_var = tk.StringVar(value="/vol2/1000/docker/dream/backend")
        self.ca_var = tk.StringVar(value=str(PROJECT_ROOT / "certs" / "ca.crt"))
        self.cert_var = tk.StringVar(value=str(PROJECT_ROOT / "certs" / "update-client.crt"))
        self.key_var = tk.StringVar(value=str(PROJECT_ROOT / "certs" / "update-client.key"))
        self.pass_file_var = tk.StringVar(value=str(PROJECT_ROOT / "certs" / "update-pass.txt"))
        self.timeout_var = tk.StringVar(value="60")
        self.status_var = tk.StringVar(value="准备就绪")

        self._build_ui()
        self.after(100, self._process_events)

    def _build_ui(self) -> None:
        self.columnconfigure(0, weight=1)
        self.rowconfigure(2, weight=1)
        form = ttk.LabelFrame(self, text="生产更新配置", padding=12)
        form.grid(row=0, column=0, sticky="ew", padx=16, pady=16)
        form.columnconfigure(1, weight=1)

        rows = [
            ("项目根目录", self.project_var),
            ("代理更新端点", self.endpoint_var),
            ("代理 SSH", self.proxy_ssh_var),
            ("TLS 服务名", self.server_name_var),
            ("主后端 SSH", self.main_ssh_var),
            ("主后端远端根目录", self.main_root_var),
            ("CA 证书", self.ca_var),
            ("更新客户端证书", self.cert_var),
            ("更新客户端私钥", self.key_var),
            ("更新密钥文件", self.pass_file_var),
            ("健康检查超时（秒）", self.timeout_var),
        ]
        for index, (label, variable) in enumerate(rows):
            ttk.Label(form, text=label).grid(row=index, column=0, sticky="w", padx=(0, 10), pady=3)
            ttk.Entry(form, textvariable=variable).grid(row=index, column=1, sticky="ew", pady=3)
        ttk.Button(form, text="选择项目", command=self._choose_project).grid(row=0, column=2, padx=(8, 0))

        actions = ttk.Frame(self, padding=(16, 0))
        actions.grid(row=1, column=0, sticky="ew")
        self.update_button = ttk.Button(actions, text="执行生产快速更新", command=self.start_update)
        self.update_button.pack(side="left")
        ttk.Button(actions, text="清空日志", command=self.clear_log).pack(side="left", padx=8)
        ttk.Label(actions, textvariable=self.status_var).pack(side="right")

        log_frame = ttk.LabelFrame(self, text="更新日志", padding=8)
        log_frame.grid(row=2, column=0, sticky="nsew", padx=16, pady=16)
        log_frame.columnconfigure(0, weight=1)
        log_frame.rowconfigure(0, weight=1)
        self.log_box = ScrolledText(log_frame, state="disabled", wrap="word", font=("Consolas", 10))
        self.log_box.grid(row=0, column=0, sticky="nsew")
        self.log("密钥只从本地文件读取，不会显示或写入日志。")

    def _choose_project(self) -> None:
        selected = filedialog.askdirectory(initialdir=self.project_var.get())
        if selected:
            self.project_var.set(selected)

    def log(self, message: str) -> None:
        self.log_box.configure(state="normal")
        self.log_box.insert("end", f"{message}\n")
        self.log_box.see("end")
        self.log_box.configure(state="disabled")

    def clear_log(self) -> None:
        self.log_box.configure(state="normal")
        self.log_box.delete("1.0", "end")
        self.log_box.configure(state="disabled")

    def start_update(self) -> None:
        if self.busy:
            return
        target = f"代理 {self.proxy_ssh_var.get()}；主后端 {self.main_ssh_var.get()}"
        if not messagebox.askyesno("确认生产更新", f"即将更新并重启生产服务：\n{target}\n\n确认继续？"):
            return
        self.busy = True
        self.update_button.configure(state="disabled")
        self.status_var.set("正在更新")
        threading.Thread(target=self._update_worker, daemon=True).start()

    def _emit_log(self, message: str) -> None:
        self.events.put(("log", message))

    def _update_worker(self) -> None:
        stage = ""
        main_committed = False
        try:
            project = Path(self.project_var.get()).resolve()
            endpoint = parse_endpoint(self.endpoint_var.get())
            proxy_ssh = validate_ssh_target(self.proxy_ssh_var.get())
            main_ssh = validate_ssh_target(self.main_ssh_var.get())
            main_root = validate_remote_root(self.main_root_var.get())
            server_name = self.server_name_var.get().strip()
            if not server_name:
                raise ValueError("TLS 服务名不能为空")
            timeout = float(self.timeout_var.get())
            if timeout < 10 or timeout > 300:
                raise ValueError("健康检查超时必须在 10 到 300 秒之间")
            update_pass = read_secret(Path(self.pass_file_var.get()))
            context = create_tls_context(Path(self.ca_var.get()), Path(self.cert_var.get()), Path(self.key_var.get()))

            commit = verify_published_source(project)
            self._emit_log(f"源版本已确认：{commit[:12]}")
            self._emit_log("正在把主后端文件暂存到生产服务器……")
            stage = stage_main_files(project, main_ssh, main_root)
            self._emit_log("主后端文件已暂存；线上文件尚未修改。")

            self._emit_log("正在建立代理 SSH 隧道和 mTLS 连接……")
            with SshTunnel(proxy_ssh, endpoint.port) as tunnel:
                tunneled_endpoint = Endpoint("127.0.0.1", tunnel.local_port, endpoint.path)
                result = request_proxy(
                    "127.0.0.1", tunneled_endpoint, server_name, context, timeout,
                    "POST", endpoint.path, update_pass,
                )
                if result.status != 200 or not isinstance(result.body, dict) or result.body.get("ok") is not True:
                    raise RuntimeError(f"代理更新失败：HTTP {result.status}：{result.text[:600]}")
                self._emit_log(f"代理更新已接受：{', '.join(result.body.get('updated', []))}")
                wait_proxy_health("127.0.0.1", tunneled_endpoint, server_name, context, timeout)
                self._emit_log("代理已重启并恢复健康。")

            self._emit_log("正在提交主后端文件并重启容器……")
            commit_main_files(main_ssh, main_root, stage)
            main_committed = True
            wait_main_health(main_ssh, timeout)
            cleanup_stage(main_ssh, stage)
            stage = ""
            self._emit_log("主后端已重启并恢复健康。")
            self.events.put(("done", f"生产更新完成：{commit[:12]}"))
        except Exception as error:
            if stage and not main_committed:
                try:
                    cleanup_stage(validate_ssh_target(self.main_ssh_var.get()), stage)
                except Exception:
                    pass
            suffix = f"；主后端备份保留在 {stage}" if stage and main_committed else ""
            self.events.put(("error", f"{error}{suffix}"))

    def _process_events(self) -> None:
        try:
            while True:
                event, payload = self.events.get_nowait()
                if event == "log":
                    self.log(str(payload))
                elif event == "done":
                    self.log(str(payload))
                    self.status_var.set("更新成功")
                    self.busy = False
                    self.update_button.configure(state="normal")
                    messagebox.showinfo("更新完成", str(payload))
                elif event == "error":
                    self.log(f"更新失败：{payload}")
                    self.status_var.set("更新失败")
                    self.busy = False
                    self.update_button.configure(state="normal")
                    messagebox.showerror("更新失败", str(payload))
        except queue.Empty:
            pass
        self.after(100, self._process_events)


if __name__ == "__main__":
    QuickUpdateApp().mainloop()
