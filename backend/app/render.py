# SPDX-License-Identifier: GPL-3.0-or-later
"""Render step: write this installation's settings into the built app.

The frontend build holds no settings. This step reads them (environment, .env) and writes
index.html, manifest.webmanifest, config.js, the icons, sw.js and version.json into the
build folder. It always starts from the pristine templates the build left in
`<folder>/template/`, so it can run again at any time with other settings. Docker runs it
at every container start; without Docker, run it after every deploy:

    python -m app.render [FOLDER]      # FOLDER: the built app, default FRONTEND_DIR
"""
import argparse
import base64
import hashlib
import html
import json
import math
import os
import re
import sys
from dataclasses import asdict, dataclass
from io import BytesIO
from pathlib import Path

from PIL import Image, UnidentifiedImageError

from .config import Settings, settings

# Files the service worker precaches with the revision "render:<url>" (frontend/vite.config.ts);
# the revision becomes the hash of the rendered file, so the precache matches what is served.
PRECACHED = ("index.html", "manifest.webmanifest", "config.js")
ICON_SIZES = {"icons/icon-192.png": 192, "icons/icon-512.png": 512, "icons/apple-touch-icon.png": 180}
MIN_ICON_SIZE = 512


class RenderError(Exception):
    pass


@dataclass(frozen=True)
class Brand:
    """The settings as the app gets them; invalid values fall back to the defaults."""

    name: str
    short_name: str
    primary: str
    secondary: str
    theme: str
    language: str
    currency: str
    topup_amounts: list
    imprint_url: str
    privacy_url: str
    db_name: str
    base_path: str


DEFAULTS = Brand(
    name="Bardesk",
    short_name="Bardesk",
    primary="#d5121e",
    secondary="#3c3c3b",
    theme="light",
    language="auto",
    currency="EUR",
    topup_amounts=[5, 10, 20],
    imprint_url="",
    privacy_url="",
    db_name="bardesk",
    base_path="/",
)


def _color(value: str, fallback: str) -> str:
    v = value.strip().lower()
    if re.fullmatch(r"#[0-9a-f]{6}", v):
        return v
    if re.fullmatch(r"#[0-9a-f]{3}", v):
        return "#" + "".join(c * 2 for c in v[1:])
    return fallback


def _url(value: str) -> str:
    v = value.strip()
    return v if re.fullmatch(r"https?://\S+", v) else ""


def _amounts(value: str) -> list:
    result = []
    for part in value.split(","):
        try:
            n = float(part)
        except ValueError:
            continue
        if math.isfinite(n) and n > 0:
            result.append(int(n) if n.is_integer() else n)
    return result[:4]


def normalize_path(value: str) -> str:
    """"/" or "/<path>/"."""
    path = value.strip().strip("/")
    return f"/{path}/" if path else "/"


def read_brand(s: Settings) -> Brand:
    name = s.app_name.strip()[:40] or DEFAULTS.name
    language = s.default_language.strip()
    currency = s.currency.strip().upper()
    return Brand(
        name=name,
        short_name=s.app_short_name.strip()[:12] or name[:12],
        primary=_color(s.color_primary, DEFAULTS.primary),
        secondary=_color(s.color_secondary, DEFAULTS.secondary),
        theme="dark" if s.theme.strip() == "dark" else "light",
        language=language if language in ("de", "en") else "auto",
        currency=currency if re.fullmatch(r"[A-Z]{3}", currency) else DEFAULTS.currency,
        topup_amounts=_amounts(s.topup_amounts) or DEFAULTS.topup_amounts,
        imprint_url=_url(s.imprint_url),
        privacy_url=_url(s.privacy_url),
        db_name=s.db_name.strip() or DEFAULTS.db_name,
        base_path=normalize_path(s.base_path),
    )


# ---- icons ----------------------------------------------------------------------------


def custom_icon(branding_dir: Path) -> bytes | None:
    """branding/icon.png (square, at least 512 px) or None for the default icon."""
    png = branding_dir / "icon.png"
    if not png.is_file():
        if (branding_dir / "icon.svg").is_file():
            raise RenderError(f"{branding_dir}/icon.svg: SVG icons are no longer supported, use icon.png")
        return None
    data = png.read_bytes()
    try:
        image = Image.open(BytesIO(data))
    except UnidentifiedImageError as exc:
        raise RenderError(f"{png}: not a PNG image") from exc
    width, height = image.size
    if image.format != "PNG" or width != height or width < MIN_ICON_SIZE:
        raise RenderError(f"{png}: must be a square PNG of at least {MIN_ICON_SIZE} px, is {image.format} {width}x{height}")
    return data


def _png(image: Image.Image, size: int) -> bytes:
    out = BytesIO()
    image.resize((size, size), Image.Resampling.LANCZOS).save(out, "PNG")
    return out.getvalue()


def icons(brand: Brand, custom: bytes | None, template: Path) -> dict[str, bytes]:
    """The app icons: the own icon, else the default mug on the primary colour."""
    if custom:
        image = Image.open(BytesIO(custom)).convert("RGBA")
    else:
        mug = Image.open(template / "icon.png").convert("RGBA")
        image = Image.new("RGBA", mug.size, brand.primary)
        image.alpha_composite(mug)
    files = {path: _png(image, size) for path, size in ICON_SIZES.items()}
    if custom:
        data = base64.b64encode(files["icons/icon-192.png"]).decode()
        favicon = (
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">'
            f'<image width="192" height="192" href="data:image/png;base64,{data}"/></svg>'
        )
    else:
        favicon = (template / "favicon.svg").read_text().replace("__PRIMARY__", brand.primary)
    files["favicon.svg"] = favicon.encode()
    return files


# ---- files ------------------------------------------------------------------------------


def _replace(text: str, old: str, new: str, file: str) -> str:
    if text.count(old) != 1:
        raise RenderError(f"template/{file}: expected {old!r} once")
    return text.replace(old, new)


def index_html(template: str, brand: Brand) -> str:
    esc = html.escape
    # browser/status bar colour on Android; on iPhone the page paints the status bar area itself.
    # A normal (opaque) status bar: the app starts below it, dark text on light, light on dark.
    replacements = [
        ('<html lang="en">', f'<html lang="en" data-theme="{brand.theme}" style="--color-primary: {brand.primary}; --color-secondary: {brand.secondary}">'),
        ('<base href="/" />', f'<base href="{esc(brand.base_path)}" />'),
        ("<title>Bardesk</title>", f"<title>{esc(brand.name)}</title>"),
        ('<meta name="theme-color" content="#111827" />', f'<meta name="theme-color" content="{brand.primary}" />'),
        (
            '<meta name="apple-mobile-web-app-capable" content="yes" />',
            '<meta name="apple-mobile-web-app-capable" content="yes" />\n'
            f'    <meta name="apple-mobile-web-app-title" content="{esc(brand.short_name)}" />',
        ),
        ('content="black-translucent"', f'content="{"black" if brand.theme == "dark" else "default"}"'),
    ]
    for old, new in replacements:
        template = _replace(template, old, new, "index.html")
    return template


def manifest(brand: Brand) -> str:
    return json.dumps(
        {
            "name": brand.name,
            "short_name": brand.short_name,
            "description": "Private, local-first drinks tab for your group",
            "start_url": ".",
            "scope": brand.base_path,
            "display": "standalone",
            "background_color": "#111827" if brand.theme == "dark" else "#f3f3f3",
            "theme_color": brand.primary,
            "lang": "en",
            "icons": [
                {"src": "icons/icon-192.png", "sizes": "192x192", "type": "image/png"},
                {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png"},
                {"src": "icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
            ],
        }
    )


def config_js(brand: Brand, version: str) -> str:
    """What the app reads (frontend/src/brand.ts); the colours and the path are in index.html."""
    config = {
        "name": brand.name,
        "theme": brand.theme,
        "language": brand.language,
        "currency": brand.currency,
        "topupAmounts": brand.topup_amounts,
        "imprintUrl": brand.imprint_url,
        "privacyUrl": brand.privacy_url,
        "dbName": brand.db_name,
        "version": version,
    }
    return f"self.BARDESK_CONFIG = {json.dumps(config)}\n"


def settings_hash(brand: Brand, custom: bytes | None) -> str:
    digest = hashlib.sha256(json.dumps(asdict(brand), sort_keys=True).encode())
    digest.update(custom or b"")
    return digest.hexdigest()[:8]


def service_worker(template: str, files: dict[str, bytes]) -> str:
    for url in PRECACHED:
        revision = hashlib.md5(files[url]).hexdigest()  # a cache key, as Workbox computes it
        template = _replace(template, f'"render:{url}"', f'"{revision}"', "sw.js")
    return template


def _write(path: Path, data: bytes) -> None:
    """Replace atomically: a web server never serves a half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def render(folder: Path, s: Settings | None = None) -> tuple[Brand, str]:
    """Write the settings into the built app in `folder`; returns them and the app version."""
    s = s or settings
    template = folder / "template"
    if not (template / "index.html").is_file():
        raise RenderError(f"{template}/index.html missing: point to a frontend build (npm run build)")
    brand = read_brand(s)
    custom = custom_icon(Path(s.branding_dir))
    # build version + settings: a change of either makes open apps update (relay 4005)
    build = json.loads((template / "version.json").read_text())["version"]
    version = f"{build}.{settings_hash(brand, custom)}"

    files = icons(brand, custom, template)
    files["config.js"] = config_js(brand, version).encode()
    files["manifest.webmanifest"] = manifest(brand).encode()
    files["index.html"] = index_html((template / "index.html").read_text(), brand).encode()
    files["sw.js"] = service_worker((template / "sw.js").read_text(), files).encode()
    # last: the relay demands the new version only once everything else is in place
    files["version.json"] = json.dumps({"version": version}).encode()
    for path, data in files.items():
        _write(folder / path, data)
    return brand, version


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.render", description=__doc__.split("\n\n")[0])
    parser.add_argument("folder", nargs="?", default=settings.frontend_dir, help="the built app (default: FRONTEND_DIR)")
    args = parser.parse_args(argv)
    if not args.folder:
        parser.error("no folder given and FRONTEND_DIR is not set")
    try:
        brand, version = render(Path(args.folder))
    except (RenderError, OSError) as exc:
        print(f"render: {exc}", file=sys.stderr)
        return 1
    print(f"render: {args.folder}: {brand.name}, BASE_PATH {brand.base_path}, DB_NAME {brand.db_name}, version {version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
