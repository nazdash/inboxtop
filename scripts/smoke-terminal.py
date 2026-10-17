"""Exercise the real launcher in a PTY and verify terminal restoration."""
import fcntl
import os
import pty
import select
import signal
import struct
import subprocess
import termios
import time
from pathlib import Path

root = Path(__file__).resolve().parent.parent
launcher = os.environ.get("INBOXTOP_TEST_BINARY", str(root / "inboxtop"))
runtime_dir = Path(launcher).resolve().parent if os.environ.get("INBOXTOP_TEST_BINARY") else root
for stop in (b"q", b"\x03", "SIGTERM"):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    before = termios.tcgetattr(slave)
    proc = subprocess.Popen([launcher, "--demo"], cwd=runtime_dir,
                            stdin=slave, stdout=slave, stderr=slave,
                            env={**os.environ, "TERM": "xterm-256color"})
    output = bytearray()
    def drain(duration):
        until = time.monotonic() + duration
        while time.monotonic() < until:
            if select.select([master], [], [], 0.03)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
    try:
        drain(1.5)
        assert proc.poll() is None, output.decode(errors="replace")
        assert b"inboxtop" in output, "App did not render"
        if stop == "SIGTERM":
            proc.send_signal(signal.SIGTERM)
        else:
            os.write(master, stop)
        drain(1)
        assert proc.wait(timeout=5) == 0, output.decode(errors="replace")
        after = termios.tcgetattr(slave)
        assert after == before, "Terminal settings were not restored"
        assert b"\x1b[?1049l" in output, "Alternate screen was not restored"
        print(f"PASS: {stop!r} exits cleanly and restores terminal settings")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        os.close(master)
        os.close(slave)

# Exercise startup against a local fake worker. Explicit temporary configuration
# keeps these PTY tests completely isolated from real mail and model credentials.
import hashlib
import http.server
import json
import re
import shutil
import socketserver
import tempfile
import threading

protocol = int(re.search(r"WORKER_PROTOCOL = (\d+)", (root / "src/worker.ts").read_text()).group(1))

class FixtureServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

for phase, stop in (("connect", b"q"), ("state", b"q"), ("state", b"\x03"),
                    ("state", "SIGTERM"), ("state", "ready"), ("error", b"q")):
    directory = Path(tempfile.mkdtemp(prefix="inboxtop-startup-")).resolve()
    account = hashlib.sha256(b"fixture.invalid:993:fictional@example.invalid").hexdigest()[:24]
    key = hashlib.sha256(f"{directory}:{account}".encode()).hexdigest()[:20]
    socket_dir = Path(f"/tmp/inboxtop-{os.getuid()}-{key}")
    socket_dir.mkdir(mode=0o700)
    env_file = directory / "fixture.env"
    env_file.write_text(f"EMAIL_ADDRESS=fictional@example.invalid\nEMAIL_PASSWORD=fictional\nIMAP_SERVER=fixture.invalid\nOPENAI_API_KEY=fictional\nINBOXTOP_DATA_DIR={directory}\n")
    gate = threading.Event()
    requested = threading.Event()
    state = {
        "revision": 1, "saved": {"version": 1, "cache": {}, "library": {}, "mode": "adhoc"},
        "status": "Saved fixture results loaded.", "busy": False, "snapshotting": False,
        "syncing": False, "mutating": False, "monitoring": False, "summaryBusy": False,
        "reviewJobs": [],
        "summaryError": "", "reused": 0, "classifiedReused": 0, "stages": [], "pendingReads": {},
        "provider": "openai", "model": "fixture",
    }

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            if self.path == "/ping":
                if phase == "connect":
                    requested.set()
                    gate.wait(10)
                status, data = 200, {"ok": True, "protocol": protocol}
            elif self.path.startswith("/state"):
                requested.set()
                if phase == "state":
                    gate.wait(10)
                status, data = (500, {"error": "Fixture could not load saved results."}) if phase == "error" else (200, state)
            else:
                status, data = 404, {}
            payload = json.dumps(data).encode()
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError):
                pass

    peer = FixtureServer(str(socket_dir / "worker.sock"), Handler)
    thread = threading.Thread(target=peer.serve_forever, daemon=True)
    thread.start()
    master, slave = pty.openpty()
    height, width = (18, 40) if stop in ("ready", "SIGTERM") else (24, 80)
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", height, width, 0, 0))
    before = termios.tcgetattr(slave)
    proc = subprocess.Popen([launcher, "--env", str(env_file)], cwd=directory,
                            stdin=slave, stdout=slave, stderr=slave,
                            env={"PATH": os.environ["PATH"], "HOME": os.environ["HOME"], "TERM": "xterm-256color"})
    output = bytearray()
    try:
        deadline = time.monotonic() + 3
        expected = b"Could not open inbox" if phase == "error" else b"Getting your inbox ready"
        while expected not in output and time.monotonic() < deadline:
            drain(0.05)
        assert expected in output, output.decode(errors="replace")
        assert requested.wait(1), "Startup never contacted fixture worker"
        if phase != "error":
            assert b"Ad hoc" not in output, "Inbox rendered before saved state arrived"
            old_output = len(output)
            drain(0.3)
            assert len(output) > old_output, "Loading animation did not update"
        if stop == "ready":
            gate.set()
            deadline = time.monotonic() + 3
            while b"Ad hoc" not in output and time.monotonic() < deadline:
                drain(0.05)
            assert b"Ad hoc" in output, "Loading screen did not hand over to inbox: " + output.decode(errors="replace")
            os.write(master, b"q")
        elif stop == "SIGTERM":
            proc.send_signal(signal.SIGTERM)
        else:
            os.write(master, stop)
        drain(0.5)
        assert proc.wait(timeout=2) == (1 if phase == "error" else 0), output.decode(errors="replace")
        assert termios.tcgetattr(slave) == before, "Startup did not restore terminal settings"
        assert b"\x1b[?1049l" in output, "Startup did not restore alternate screen"
        print(f"PASS: startup {phase}/{stop!r} renders promptly and exits cleanly")
    finally:
        gate.set()
        if proc.poll() is None:
            proc.kill()
            proc.wait()
        peer.shutdown()
        peer.server_close()
        thread.join(timeout=1)
        os.close(master)
        os.close(slave)
        shutil.rmtree(directory)
        shutil.rmtree(socket_dir)

# Fresh secure setup: no existing account, no network, no vault writes on cancel.
for edit_secret in (False, True):
    directory = Path(tempfile.mkdtemp(prefix="inboxtop-onboarding-")).resolve()
    profile = directory / "config.json"
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 18, 40, 0, 0))
    before = termios.tcgetattr(slave)
    proc = subprocess.Popen([launcher, "setup", "--profile", str(profile)], cwd=directory,
                            stdin=slave, stdout=slave, stderr=slave,
                            env={**os.environ, "TERM": "xterm-256color"})
    output = bytearray()
    try:
        drain(1.2)
        assert b"Welcome" in output, "Fresh setup did not render"
        if edit_secret:
            os.write(master, b"\x1b[B\r")  # Connect email
            drain(0.2)
            for _ in range(4):
                os.write(master, b"\x1b[B")
                drain(0.05)
            os.write(master, b"\r")
            drain(0.2)
            os.write(master, b"private-fictional-password")
            drain(0.3)
            assert b"private-fictional-password" not in output, "Secret was rendered"
            os.write(master, b"\x03")
        else:
            os.write(master, b"\x1b")
        drain(0.7)
        assert proc.wait(timeout=5) == 0, "Setup cancellation failed"
        assert termios.tcgetattr(slave) == before, "Setup did not restore terminal"
        assert not profile.exists(), "Cancel wrote a configuration"
        print(f"PASS: fresh onboarding, secret edit={edit_secret}, restores terminal without saving")
    finally:
        if proc.poll() is None:
            proc.kill(); proc.wait()
        os.close(master); os.close(slave)
        shutil.rmtree(directory)
