# SPDX-License-Identifier: GPL-3.0-or-later
"""Render step: settings into the built app, from pristine templates, any number of times."""
import hashlib
import json
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from app import render as r
from app.config import Settings

# the real page template (frontend/index.html); the build only adds script and style tags
INDEX = (Path(__file__).parents[2] / "frontend" / "index.html").read_text()
SW = 'precacheAndRoute([{url:"assets/a.js",revision:null},' + ",".join(
    f'{{url:"{url}",revision:"render:{url}"}}' for url in r.PRECACHED
) + "])"


def png(size: tuple[int, int], color=(0, 0, 0, 0), fmt="PNG") -> bytes:
    out = BytesIO()
    Image.new("RGBA" if fmt == "PNG" else "RGB", size, color).save(out, fmt)
    return out.getvalue()


@pytest.fixture()
def dist(tmp_path) -> Path:
    template = tmp_path / "dist" / "template"
    template.mkdir(parents=True)
    (template / "index.html").write_text(INDEX)
    (template / "sw.js").write_text(SW)
    (template / "version.json").write_text('{"version": "0.9.0+build1"}')
    (template / "icon.png").write_bytes(png((512, 512)))  # the mug: transparent here
    (template / "favicon.svg").write_text('<svg><rect fill="__PRIMARY__"/></svg>')
    (tmp_path / "branding").mkdir()
    return tmp_path / "dist"


def settings(dist: Path, **values) -> Settings:
    return Settings(_env_file=None, branding_dir=str(dist.parent / "branding"), **values)


def config(dist: Path) -> dict:
    text = (dist / "config.js").read_text()
    assert text.startswith("self.BARDESK_CONFIG = ")
    return json.loads(text.removeprefix("self.BARDESK_CONFIG = "))


def test_defaults(dist):
    brand, version = r.render(dist, settings(dist))
    assert brand == r.DEFAULTS
    page = (dist / "index.html").read_text()
    assert '<html lang="en" data-theme="light" style="--color-primary: #d5121e; --color-secondary: #3c3c3b">' in page
    assert '<base href="/" />' in page and "<title>Bardesk</title>" in page
    assert '<meta name="theme-color" content="#d5121e" />' in page
    assert '<meta name="apple-mobile-web-app-status-bar-style" content="default" />' in page
    assert config(dist) == {
        "name": "Bardesk",
        "theme": "light",
        "language": "auto",
        "currency": "EUR",
        "topupAmounts": [5, 10, 20],
        "imprintUrl": "",
        "privacyUrl": "",
        "dbName": "bardesk",
        "version": version,
    }
    manifest = json.loads((dist / "manifest.webmanifest").read_text())
    assert (manifest["name"], manifest["scope"], manifest["start_url"]) == ("Bardesk", "/", ".")
    assert json.loads((dist / "version.json").read_text()) == {"version": version}
    assert version.startswith("0.9.0+build1.")


def test_reads_all_settings(dist):
    brand, version = r.render(
        dist,
        settings(
            dist,
            app_name="  Vereinsheim <Tab> ",
            app_short_name="Vereinsheim",
            color_primary="#0A6",
            color_secondary="#112233",
            theme="dark",
            default_language="de",
            currency="chf",
            topup_amounts="2, 5,10, 2.5, 50",
            imprint_url="https://example.org/impressum",
            privacy_url="https://example.org/datenschutz",
            db_name=" taplist ",
            base_path="pub",
        ),
    )
    page = (dist / "index.html").read_text()
    assert 'data-theme="dark" style="--color-primary: #00aa66; --color-secondary: #112233"' in page
    assert '<base href="/pub/" />' in page
    assert "<title>Vereinsheim &lt;Tab&gt;</title>" in page
    assert '<meta name="apple-mobile-web-app-title" content="Vereinsheim" />' in page
    assert '<meta name="apple-mobile-web-app-status-bar-style" content="black" />' in page
    assert config(dist) == {
        "name": "Vereinsheim <Tab>",
        "theme": "dark",
        "language": "de",
        "currency": "CHF",
        "topupAmounts": [2, 5, 10, 2.5],
        "imprintUrl": "https://example.org/impressum",
        "privacyUrl": "https://example.org/datenschutz",
        "dbName": "taplist",
        "version": version,
    }
    manifest = json.loads((dist / "manifest.webmanifest").read_text())
    assert manifest["scope"] == "/pub/" and manifest["background_color"] == "#111827"
    assert manifest["short_name"] == "Vereinsheim" and manifest["theme_color"] == "#00aa66"


def test_invalid_values_fall_back():
    brand = r.read_brand(
        Settings(
            _env_file=None,
            color_primary="red",
            theme="purple",
            default_language="fr",
            currency="euro",
            topup_amounts="a,-1,0",
            imprint_url="javascript:alert(1)",
            app_name="A very long name that nobody could ever read on a home screen",
        )
    )
    assert brand.primary == r.DEFAULTS.primary
    assert (brand.theme, brand.language, brand.currency) == ("light", "auto", "EUR")
    assert brand.topup_amounts == [5, 10, 20] and brand.imprint_url == ""
    assert (len(brand.name), len(brand.short_name)) == (40, 12)


@pytest.mark.parametrize("value, path", [("/", "/"), ("", "/"), ("/tab/", "/tab/"), ("tab", "/tab/"), ("/a/b", "/a/b/")])
def test_base_path(value, path):
    assert r.normalize_path(value) == path


def test_renders_again_from_the_templates(dist):
    first = settings(dist, app_name="First", theme="dark", base_path="/pub/", db_name="one")
    second = settings(dist, app_name="Second")
    _, v1 = r.render(dist, first)
    r.render(dist, second)
    rendered_twice = {p: p.read_bytes() for p in dist.rglob("*") if p.is_file()}
    _, v2 = r.render(dist, second)
    assert rendered_twice == {p: p.read_bytes() for p in dist.rglob("*") if p.is_file()}
    page = (dist / "index.html").read_text()
    assert "<title>Second</title>" in page and '<base href="/" />' in page and "First" not in page
    assert v1 != v2 and v1.split(".")[:-1] == v2.split(".")[:-1]  # same build, other settings
    assert (dist / "template" / "index.html").read_text() == INDEX


def test_version_changes_with_every_setting_and_the_icon(dist):
    versions = {r.render(dist, settings(dist))[1]}
    for change in ({"db_name": "x"}, {"base_path": "/x/"}, {"color_secondary": "#000000"}, {"currency": "CHF"}):
        versions.add(r.render(dist, settings(dist, **change))[1])
    (dist.parent / "branding" / "icon.png").write_bytes(png((512, 512), (0, 128, 0, 255)))
    versions.add(r.render(dist, settings(dist))[1])
    assert len(versions) == 6
    assert r.render(dist, settings(dist))[1] in versions  # same settings, same version


def test_precache_revisions_match_the_rendered_files(dist):
    r.render(dist, settings(dist, app_name="Precached"))
    sw = (dist / "sw.js").read_text()
    assert "render:" not in sw and '{url:"assets/a.js",revision:null}' in sw
    for url in r.PRECACHED:
        assert f'{{url:"{url}",revision:"{hashlib.md5((dist / url).read_bytes()).hexdigest()}"}}' in sw


def test_default_icon_on_the_primary_colour(dist):
    r.render(dist, settings(dist, color_primary="#123456"))
    for path, size in r.ICON_SIZES.items():
        image = Image.open(dist / path)
        assert image.size == (size, size)
        assert image.convert("RGB").getpixel((0, 0)) == (0x12, 0x34, 0x56)  # the mug is transparent here
    assert (dist / "favicon.svg").read_text() == '<svg><rect fill="#123456"/></svg>'


def test_own_icon(dist):
    (dist.parent / "branding" / "icon.png").write_bytes(png((1024, 1024), (0, 255, 0, 255)))
    r.render(dist, settings(dist, color_primary="#123456"))
    for path, size in r.ICON_SIZES.items():
        image = Image.open(dist / path)
        assert image.size == (size, size) and image.convert("RGB").getpixel((size // 2, size // 2)) == (0, 255, 0)
    assert "data:image/png;base64," in (dist / "favicon.svg").read_text()


@pytest.mark.parametrize(
    "name, data, message",
    [
        ("icon.png", png((512, 400)), "square PNG"),
        ("icon.png", png((256, 256)), "square PNG"),
        ("icon.png", png((512, 512), fmt="JPEG"), "square PNG"),
        ("icon.png", b"not an image", "not a PNG"),
        ("icon.svg", b"<svg/>", "no longer supported"),
    ],
)
def test_refuses_unusable_icons(dist, name, data, message):
    (dist.parent / "branding" / name).write_bytes(data)
    with pytest.raises(r.RenderError, match=message):
        r.render(dist, settings(dist))
    assert not (dist / "index.html").exists()  # nothing written


def test_needs_a_build(tmp_path):
    with pytest.raises(r.RenderError, match="npm run build"):
        r.render(tmp_path, Settings(_env_file=None))


def test_cli(dist, monkeypatch, capsys):
    monkeypatch.setattr(r, "settings", settings(dist, app_name="Cli", db_name="taplist", base_path="/pub/"))
    assert r.main([str(dist)]) == 0
    assert "Cli, BASE_PATH /pub/, DB_NAME taplist, version 0.9.0+build1." in capsys.readouterr().out
    assert r.main([str(dist.parent)]) == 1
    assert "npm run build" in capsys.readouterr().err
