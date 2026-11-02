# SPDX-License-Identifier: GPL-3.0-or-later
"""Self-hosting features: SMTP mail, login rate limit, serving the built frontend."""
import pytest

import app.routers.auth as auth_router
from app.config import settings
from app.services import mail


class FakeSMTP:
    sent: list = []

    def __init__(self, host, port, timeout=None, context=None):
        self.host, self.port, self.calls = host, port, []

    def starttls(self, context=None):
        self.calls.append("starttls")

    def login(self, user, password):
        self.calls.append(("login", user, password))

    def send_message(self, message):
        FakeSMTP.sent.append((self, message))

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_login_code_via_smtp(monkeypatch):
    FakeSMTP.sent = []
    monkeypatch.setattr(mail.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.org")
    monkeypatch.setattr(settings, "smtp_user", "tab@example.org")
    monkeypatch.setattr(settings, "smtp_password", "secret")
    monkeypatch.setattr(settings, "from_email", "tab@example.org")

    assert mail.send_login_code("alice@example.com", "123456", language="de")
    server, message = FakeSMTP.sent[0]
    assert (server.host, server.port) == ("smtp.example.org", 587)
    assert server.calls == ["starttls", ("login", "tab@example.org", "secret")]
    assert message["To"] == "alice@example.com"
    assert message["Subject"] == "Dein Bardesk Login-Code"
    assert "123456" in message.get_body(("plain",)).get_content()
    assert "123456" in message.get_body(("html",)).get_content()


def test_login_email_uses_the_app_name(monkeypatch):
    FakeSMTP.sent = []
    monkeypatch.setattr(mail.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.org")
    monkeypatch.setattr(settings, "app_name", "Vereinsheim <Tab>")
    assert mail.send_login_code("alice@example.com", "123456", language="en")
    message = FakeSMTP.sent[0][1]
    assert message["Subject"] == "Your Vereinsheim <Tab> login code"
    assert "Vereinsheim &lt;Tab&gt;" in message.get_body(("html",)).get_content()


def test_smtp_failure_is_reported(monkeypatch):
    class Broken(FakeSMTP):
        def send_message(self, message):
            raise OSError("connection refused")

    monkeypatch.setattr(mail.smtplib, "SMTP", Broken)
    monkeypatch.setattr(settings, "smtp_host", "smtp.example.org")
    assert mail.send_login_code("alice@example.com", "123456") is False


def test_without_mail_config_the_code_is_logged(monkeypatch, caplog):
    monkeypatch.setattr(settings, "smtp_host", None)
    assert mail.send_login_code("alice@example.com", "654321")
    assert "Login code for alice@example.com: 654321" in caplog.text


def test_login_requests_are_rate_limited(client, monkeypatch):
    monkeypatch.setattr(settings, "auth_rate_limit_per_minute", 2)
    auth_router._requests.clear()
    for _ in range(2):
        assert client.post("/api/auth/request-login", json={"email": "a@example.com"}).status_code == 200
    assert client.post("/api/auth/request-login", json={"email": "a@example.com"}).status_code == 429
    auth_router._requests.clear()


@pytest.fixture()
def frontend_dir(tmp_path, monkeypatch):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text("<html>app</html>")
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log(1)")
    (tmp_path / "version.json").write_text('{"version": "0.4.0+x"}')
    monkeypatch.setattr(settings, "frontend_dir", str(tmp_path))
    return tmp_path


def test_serves_the_app_with_cache_headers(client, frontend_dir):
    index = client.get("/")
    assert index.status_code == 200 and "app" in index.text
    assert index.headers["cache-control"] == "no-cache"

    asset = client.get("/assets/index-abc123.js")
    assert asset.headers["cache-control"] == "public, max-age=31536000, immutable"

    route = client.get("/groups/some-id/chat")  # client-side route -> the app
    assert route.status_code == 200 and "app" in route.text
    assert route.headers["cache-control"] == "no-cache"


def test_missing_files_and_unknown_api_paths_stay_404(client, frontend_dir):
    assert client.get("/assets/missing.js").status_code == 404
    assert client.get("/api/nope").status_code == 404
    assert client.get("/api/health").json()["status"] == "ok"


def test_version_file_defaults_to_the_served_frontend(frontend_dir):
    from app.relay import deployed_version

    assert deployed_version() == "0.4.0+x"
