# SPDX-License-Identifier: GPL-3.0-or-later
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "sqlite:///./bardesk.db"

    login_code_expiry_minutes: int = 5

    # version.json of the deployed frontend; if set, only that app version may sync
    # (older apps must update first). Unset in dev and tests: no check.
    frontend_version_file: str | None = None

    # Login-code mail via SMTP (any provider). Without SMTP_HOST the code is only
    # written to the log (trying it out, development, tests).
    smtp_host: str | None = None
    smtp_port: int = 587
    smtp_security: str = "starttls"  # starttls | ssl | none
    smtp_user: str | None = None
    smtp_password: str | None = None
    from_email: str = "bardesk@example.org"
    from_name: str = "Bardesk"
    # the app's name: in the app (render step) and in the login emails
    app_name: str = "Bardesk"

    # Self-hosting without nginx: serve the built frontend from this directory
    # (with SPA fallback and cache headers). Also implies its version.json and is where
    # the render step writes by default.
    frontend_dir: str | None = None

    # Login requests per minute and client IP; 0 = off (e.g. when a reverse proxy limits instead)
    auth_rate_limit_per_minute: int = 10

    # ---- written into the built app by the render step (app/render.py) ----
    # where the app lives on its domain: "/" or e.g. "/tab/"
    base_path: str = "/"
    # look and defaults; invalid or empty values fall back to the defaults (see render.py)
    app_short_name: str = ""
    color_primary: str = ""
    color_secondary: str = ""
    theme: str = ""
    default_language: str = ""
    currency: str = ""
    topup_amounts: str = ""
    imprint_url: str = ""
    privacy_url: str = ""
    # IndexedDB name for a device's first start; devices keep theirs afterwards
    db_name: str = ""
    # own icon: icon.png in this folder (relative to the working directory)
    branding_dir: str = "../branding"

    @property
    def version_file(self) -> str | None:
        if self.frontend_version_file:
            return self.frontend_version_file
        return f"{self.frontend_dir.rstrip('/')}/version.json" if self.frontend_dir else None


settings = Settings()
