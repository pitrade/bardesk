# Own app icon (optional)

Put `icon.png` (a square PNG, at least 512×512) here. It replaces the default icon (a white
beer mug on the primary colour) for the home screen, the browser tab and the login screen.
Without a file here, the default icon is used. SVG icons are not supported.

The render step reads it (`BRANDING_DIR`, default `../branding` from `backend/`): with
Docker, the `branding/` folder next to `docker-compose.yaml`, then `docker compose restart
app`; without Docker, run the render step again.
